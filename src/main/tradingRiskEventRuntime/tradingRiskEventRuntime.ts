/**
 * TradingRiskEventRuntime
 *
 * 职责：
 * - 监听 quoteClient 发布的标准化 quote 事件
 * - 每次事件到达时基于 symbolRegistry 重建路由索引
 * - 对同一路由执行 single-flight + latest-only collapse
 * - 通过单方向浮亏执行器触发保护性清仓
 */
import { isBeforeClose5Minutes } from '../../core/doomsdayProtection/utils.js';
import { isValidPositiveNumber } from '../../utils/helpers/index.js';
import { formatError } from '../../utils/error/index.js';
import { logger } from '../../utils/logger/index.js';
import { isTradingRiskRouteCurrent, resolveTradingRiskRoute } from './routeValidation.js';
import { buildTradingRiskRoutingIndex } from './routingIndex.js';
import { executeDirectionalUnrealizedLoss } from './unrealizedLossExecutor.js';
import type { QuoteUpdatedEvent } from '../../types/services.js';
import type {
  RouteExecutionState,
  TradingRiskEventRuntime,
  TradingRiskEventRuntimeDeps,
  TradingRiskRoutingIndex,
} from './types.js';

/**
 * 创建单 route 的初始执行状态。
 *
 * @returns 初始空状态
 */
function createRouteExecutionState(): RouteExecutionState {
  return {
    inFlight: false,
    dirty: false,
    latestRoute: null,
    latestEvent: null,
  };
}

/**
 * 判断 waitForFresh 的失败是否属于 stopAndDrain 主动中断。
 *
 * @param error waitForFresh 抛出的错误
 * @returns 属于 STOP_AND_DRAIN 中断时返回 true
 */
function isStopAndDrainAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === '[postTradeConsistencyRuntime] freshness wait aborted: STOP_AND_DRAIN'
  );
}

/**
 * 创建 TradingRiskEventRuntime。
 *
 * @param deps 风险 runtime 依赖
 * @returns TradingRiskEventRuntime 实例
 */
export function createTradingRiskEventRuntime(
  deps: TradingRiskEventRuntimeDeps,
): TradingRiskEventRuntime {
  let running = false;
  let unsubscribeQuoteUpdated: (() => void) | null = null;
  const routeStates = new Map<string, RouteExecutionState>();
  const activeRoutePromises = new Set<Promise<void>>();

  /**
   * 获取或创建 route 状态。
   *
   * @param routeKey 路由键
   * @returns 对应的执行状态
   */
  function getRouteState(routeKey: string): RouteExecutionState {
    const existing = routeStates.get(routeKey);
    if (existing) {
      return existing;
    }

    const nextState = createRouteExecutionState();
    routeStates.set(routeKey, nextState);
    return nextState;
  }

  /**
   * 清理已经不再活跃且没有 in-flight 的 route 状态。
   *
   * @param activeRouteKeys 当前 symbolRegistry 快照下的活跃 routeKey 集合
   */
  function pruneRouteStates(activeRouteKeys: ReadonlySet<string>): void {
    for (const [routeKey, state] of routeStates) {
      if (state.inFlight) {
        continue;
      }

      if (!activeRouteKeys.has(routeKey)) {
        routeStates.delete(routeKey);
      }
    }
  }

  /**
   * 基于当前 symbolRegistry 权威快照重建路由索引。
   *
   * @returns 最新路由索引
   */
  function rebuildRoutingIndex(): TradingRiskRoutingIndex {
    const routingIndex = buildTradingRiskRoutingIndex({
      monitorContexts: deps.monitorContexts,
      symbolRegistry: deps.symbolRegistry,
    });
    pruneRouteStates(new Set(routingIndex.routesByKey.keys()));
    return routingIndex;
  }

  /**
   * 判断当前 runtime gate 是否打开。
   *
   * 该 gate 必须同时复用 lifecycle 交易门禁、连续交易时段门禁，以及末日保护收盘前 5 分钟接管语义。
   *
   * @returns 允许执行风险事件时返回 true
   */
  function isExecutionGateOpen(): boolean {
    if (!deps.lastState.isTradingEnabled || deps.lastState.canTrade !== true) {
      return false;
    }

    if (!deps.doomsdayProtectionEnabled) {
      return true;
    }

    return !isBeforeClose5Minutes(deps.now(), deps.lastState.isHalfDay ?? false);
  }

  /**
   * 判断当前 baseline 是否已经完成。
   *
   * @returns 已启动且 currentVersion 追平 staleVersion 时返回 true
   */
  function isBaselineReady(): boolean {
    const status = deps.postTradeConsistencyRuntime.getStatus();
    return status.started && status.currentVersion === status.staleVersion;
  }

  /**
   * 发起某个 route 的 single-flight 执行。
   *
   * @param routeKey 路由键
   */
  function launchRouteProcessing(routeKey: string): void {
    const processingPromise = processRouteQueue(routeKey).catch((error: unknown) => {
      logger.error('[TradingRiskEventRuntime] 风险事件处理失败', formatError(error));
    });

    activeRoutePromises.add(processingPromise);
    void processingPromise.finally(() => {
      activeRoutePromises.delete(processingPromise);
    });
  }

  /**
   * 消费单条标准化行情事件。
   *
   * @param event quoteClient 发布的标准化 quote 事件
   */
  function handleQuoteUpdated(event: QuoteUpdatedEvent): void {
    if (!running) {
      return;
    }

    if (!isValidPositiveNumber(event.quote.price)) {
      return;
    }

    const routingIndex = rebuildRoutingIndex();
    const route = resolveTradingRiskRoute(routingIndex, event.symbol);
    if (!route) {
      return;
    }

    const routeState = getRouteState(route.routeKey);
    routeState.latestRoute = route;
    routeState.latestEvent = event;
    routeState.dirty = true;

    if (routeState.inFlight) {
      return;
    }

    routeState.inFlight = true;
    launchRouteProcessing(route.routeKey);
  }

  /**
   * 处理单 route 的 latest-only 队列。
   *
   * 固定顺序：
   * 1. freshness 前 gate / baseline / seat 校验
   * 2. waitForFresh
   * 3. freshness 后再次校验 gate / baseline / seat
   * 4. 读取当前 route 收敛后的 latest event quote
   * 5. 执行单方向浮亏检查
   *
   * @param routeKey 路由键
   */
  async function processRouteQueue(routeKey: string): Promise<void> {
    const routeState = getRouteState(routeKey);

    try {
      while (running && routeState.dirty) {
        routeState.dirty = false;

        const snapshotRoute = routeState.latestRoute;
        const snapshotEvent = routeState.latestEvent;
        if (!snapshotRoute || !snapshotEvent) {
          continue;
        }

        if (!isExecutionGateOpen() || !isBaselineReady()) {
          return;
        }

        const routingIndexBeforeFresh = rebuildRoutingIndex();
        if (!isTradingRiskRouteCurrent(snapshotRoute, routingIndexBeforeFresh)) {
          return;
        }

        try {
          await deps.postTradeConsistencyRuntime.waitForFresh();
        } catch (error) {
          if (isStopAndDrainAbortError(error)) {
            return;
          }

          throw error;
        }

        if (!isExecutionGateOpen() || !isBaselineReady()) {
          return;
        }

        const routingIndexAfterFresh = rebuildRoutingIndex();
        if (!isTradingRiskRouteCurrent(snapshotRoute, routingIndexAfterFresh)) {
          return;
        }

        const latestRoute = routeState.latestRoute;
        const latestEvent = routeState.latestEvent;
        if (!latestRoute || !latestEvent) {
          return;
        }

        if (!isValidPositiveNumber(latestEvent.quote.price)) {
          return;
        }

        await executeDirectionalUnrealizedLoss({
          route: latestRoute,
          event: latestEvent,
          trader: deps.trader,
        });
      }
    } finally {
      routeState.inFlight = false;
      if (routeState.dirty && running) {
        routeState.inFlight = true;
        launchRouteProcessing(routeKey);
      }
    }
  }

  /**
   * 启动 runtime 并订阅标准化 quote 事件。
   */
  function start(): void {
    if (running) {
      return;
    }

    rebuildRoutingIndex();
    running = true;
    unsubscribeQuoteUpdated = deps.marketDataClient.onQuoteUpdated((event) => {
      handleQuoteUpdated(event);
    });
  }

  /**
   * 停止 runtime 并等待当前 in-flight route 执行完成。
   */
  async function stopAndDrain(): Promise<void> {
    running = false;
    unsubscribeQuoteUpdated?.();
    unsubscribeQuoteUpdated = null;

    if (activeRoutePromises.size > 0) {
      await Promise.allSettled(activeRoutePromises);
    }

    routeStates.clear();
  }

  return {
    start,
    stopAndDrain,
  };
}

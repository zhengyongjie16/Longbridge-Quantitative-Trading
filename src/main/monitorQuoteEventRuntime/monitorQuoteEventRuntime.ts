/**
 * MonitorQuoteEventRuntime
 *
 * 职责：
 * - 监听 monitor quote 与静态清仓 wakeup symbols 的标准化 quote 事件
 * - 对单个 monitorSymbol 执行 single-flight + latest-only collapse
 * - 在执行前统一复用 lifecycle gate、freshness baseline 与 waitForFresh 门禁
 * - 在 autoSearch 开启时启动距离换标，在关闭时接管静态距回收价清仓 WAIT owner
 */
import { isWithinDoomsdayClearanceTakeoverWindow } from '../../core/doomsdayProtection/utils.js';
import { formatError } from '../../utils/error/index.js';
import { logger } from '../../utils/logger/index.js';
import type { StartSwitchOnDistanceResult } from '../../types/monitorContextPorts.js';
import type { MonitorContext } from '../../types/state.js';
import type { QuoteUpdatedEvent } from '../../types/services.js';
import { isSeatActive } from '../../utils/seat/guards.js';
import { createStaticLiquidationExecutor } from './staticLiquidationExecutor.js';
import type {
  CreateDefaultMonitorQuoteEventRuntimeDeps,
  CreateMonitorQuoteEventRuntimeDeps,
  MonitorQuoteEventRuntime,
  MonitorQuoteEventExecutor,
  MonitorQuoteRouteMode,
  MonitorQuoteRouteState,
  StaticLiquidationRuntimeResult,
  StartDistanceSwitchExecutor,
} from './types.js';

/**
 * 根据 quote 事件查找监控上下文。
 *
 * @param params.monitorContexts monitor 上下文索引
 * @param params.event 标准化 quote 事件
 * @returns 命中的 monitor 上下文；未命中时返回 null
 */
function getMonitorContextForQuoteEvent(params: {
  readonly monitorContexts: ReadonlyMap<string, MonitorContext>;
  readonly event: QuoteUpdatedEvent;
}): MonitorContext | null {
  return params.monitorContexts.get(params.event.symbol) ?? null;
}

/**
 * 判断当前 runtime gate 是否打开。
 *
 * @param deps runtime 依赖
 * @returns 允许执行事件时返回 true
 */
function isExecutionGateOpen(deps: CreateMonitorQuoteEventRuntimeDeps): boolean {
  if (!deps.lastState) {
    return true;
  }

  if (!deps.lastState.isTradingEnabled || deps.lastState.canTrade !== true) {
    return false;
  }

  if (!deps.doomsdayProtectionEnabled) {
    return true;
  }

  return !isWithinDoomsdayClearanceTakeoverWindow(
    deps.now?.() ?? new Date(),
    deps.lastState.isHalfDay ?? false,
  );
}

/**
 * 判断当前 baseline 是否已经 ready。
 *
 * @param deps runtime 依赖
 * @returns baseline ready 时返回 true
 */
function isBaselineReady(deps: CreateMonitorQuoteEventRuntimeDeps): boolean {
  if (!deps.postTradeConsistencyRuntime) {
    return true;
  }

  const status = deps.postTradeConsistencyRuntime.getStatus();
  return status.started && status.currentVersion === status.staleVersion;
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
 * 创建 route 初始状态。
 *
 * @param mode route 模式
 * @returns 初始 route 状态
 */
function createRouteState(mode: MonitorQuoteRouteMode): MonitorQuoteRouteState {
  return {
    latestMonitorContext: null,
    latestEvent: null,
    wakeupSymbols: new Set(),
    mode,
    inFlight: false,
    dirty: false,
    retryAttempts: 0,
    retryTimerHandle: null,
  };
}

/**
 * 为 autoSearch 关闭场景创建真实静态清仓执行器。
 *
 * @param deps 清仓执行所需的最小真实依赖
 * @returns monitor quote 驱动的静态清仓执行函数
 */
function createDefaultStaticLiquidationExecutor(
  deps: CreateDefaultMonitorQuoteEventRuntimeDeps,
): MonitorQuoteEventExecutor {
  return createStaticLiquidationExecutor({
    trader: deps.trader,
    marketDataClient: deps.marketDataClient,
    lastState: deps.lastState,
  });
}

/**
 * 为 autoSearch 开启场景创建最小距离换标启动执行器。
 *
 * @param deps 持仓快照依赖
 * @returns monitor quote 驱动的距离换标启动执行函数
 */
function createDefaultStartDistanceSwitchExecutor(
  deps: Pick<CreateDefaultMonitorQuoteEventRuntimeDeps, 'lastState'>,
): StartDistanceSwitchExecutor {
  return async function startDistanceSwitchOnMonitorQuote(params: {
    readonly monitorContext: MonitorContext;
    readonly event: QuoteUpdatedEvent;
  }): Promise<ReadonlyArray<StartSwitchOnDistanceResult>> {
    const { monitorContext, event } = params;
    const monitorSymbol = monitorContext.config.monitorSymbol;
    const longSeat = monitorContext.symbolRegistry.getSeatState(monitorSymbol, 'LONG');
    const shortSeat = monitorContext.symbolRegistry.getSeatState(monitorSymbol, 'SHORT');
    const monitorPrice = event.quote.price;
    const positions = deps.lastState.cachedPositions;
    const results: StartSwitchOnDistanceResult[] = [];

    if (isSeatActive(longSeat)) {
      results.push(
        await monitorContext.autoSymbolManager.startSwitchOnDistance({
          direction: 'LONG',
          monitorPrice,
          positions,
        }),
      );
    }

    if (isSeatActive(shortSeat)) {
      results.push(
        await monitorContext.autoSymbolManager.startSwitchOnDistance({
          direction: 'SHORT',
          monitorPrice,
          positions,
        }),
      );
    }

    return results;
  };
}

/**
 * 创建模块内默认 monitor quote runtime 组装入口。
 *
 * @param deps 真实清仓与距离换标启动所需的最小依赖
 * @returns 已组装真实执行依赖的 runtime
 */
export function createDefaultMonitorQuoteEventRuntime(
  deps: CreateDefaultMonitorQuoteEventRuntimeDeps,
): MonitorQuoteEventRuntime {
  const runtimeDeps: CreateMonitorQuoteEventRuntimeDeps = {
    marketDataClient: deps.marketDataClient,
    monitorContexts: deps.monitorContexts,
    executeStaticLiquidation: createDefaultStaticLiquidationExecutor(deps),
    startDistanceSwitch: createDefaultStartDistanceSwitchExecutor({
      lastState: deps.lastState,
    }),
    ...(deps.handoffPendingSwitch ? { handoffPendingSwitch: deps.handoffPendingSwitch } : {}),
    ...(deps.scheduleTimer ? { scheduleTimer: deps.scheduleTimer } : {}),
    ...(deps.clearTimer ? { clearTimer: deps.clearTimer } : {}),
    ...(deps.quoteSubscriptionRuntime
      ? { quoteSubscriptionRuntime: deps.quoteSubscriptionRuntime }
      : {}),
    lastState: deps.lastState,
    postTradeConsistencyRuntime: deps.postTradeConsistencyRuntime,
    doomsdayProtectionEnabled: deps.doomsdayProtectionEnabled,
    now: deps.now,
  };

  return createMonitorQuoteEventRuntime(runtimeDeps);
}

/**
 * 创建 MonitorQuoteEventRuntime。
 *
 * @param deps 行情事件源与最小执行依赖
 * @returns runtime 实例
 */
function createMonitorQuoteEventRuntime(
  deps: CreateMonitorQuoteEventRuntimeDeps,
): MonitorQuoteEventRuntime {
  const {
    marketDataClient,
    monitorContexts,
    executeStaticLiquidation,
    startDistanceSwitch,
    handoffPendingSwitch,
  } = deps;
  const scheduleTimer = deps.scheduleTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;

  let running = false;
  let unsubscribeQuoteUpdated: (() => void) | null = null;
  const routeStates = new Map<string, MonitorQuoteRouteState>();
  const activePromises = new Set<Promise<void>>();

  /**
   * 获取或创建 route 状态。
   *
   * @param monitorSymbol 监控标的
   * @param mode route 模式
   * @returns route 状态
   */
  function getOrCreateRouteState(
    monitorSymbol: string,
    mode: MonitorQuoteRouteMode,
  ): MonitorQuoteRouteState {
    const existing = routeStates.get(monitorSymbol);
    if (existing) {
      if (existing.mode !== mode) {
        if (existing.retryTimerHandle !== null) {
          clearTimer(existing.retryTimerHandle);
          existing.retryTimerHandle = null;
        }

        releaseStaticLiquidationRetain(monitorSymbol);
        existing.mode = mode;
        existing.wakeupSymbols = new Set();
        existing.retryAttempts = 0;
      }

      return existing;
    }

    const nextState = createRouteState(mode);
    routeStates.set(monitorSymbol, nextState);
    return nextState;
  }

  /**
   * 注册在途 promise。
   *
   * @param promise 在途 promise
   */
  function registerInFlight(promise: Promise<void>): void {
    activePromises.add(promise);
    void promise.finally(() => {
      activePromises.delete(promise);
    });
  }

  /**
   * 释放静态清仓 WAIT 持有的 quote retain。
   *
   * @param monitorSymbol 监控标的
   */
  function releaseStaticLiquidationRetain(monitorSymbol: string): void {
    const quoteSubscriptionRuntime = deps.quoteSubscriptionRuntime;
    if (quoteSubscriptionRuntime === undefined) {
      return;
    }

    void quoteSubscriptionRuntime
      .releaseRetain({
        ownerKey: monitorSymbol,
        reason: 'STATIC_LIQUIDATION_WAIT',
      })
      .catch((error: unknown) => {
        logger.error(
          '[MonitorQuoteEventRuntime] 释放静态清仓 quote retain 失败',
          formatError(error),
        );
      });
  }

  /**
   * 注册静态清仓 WAIT 期间需要保留订阅的 quote symbols。
   *
   * @param monitorSymbol 监控标的
   * @param symbols 等待期间需要保留订阅的标的
   */
  function retainStaticLiquidationSymbols(
    monitorSymbol: string,
    symbols: ReadonlySet<string>,
  ): void {
    const quoteSubscriptionRuntime = deps.quoteSubscriptionRuntime;
    if (quoteSubscriptionRuntime === undefined) {
      return;
    }

    if (symbols.size === 0) {
      releaseStaticLiquidationRetain(monitorSymbol);
      return;
    }

    void quoteSubscriptionRuntime
      .retainSymbols({
        ownerKey: monitorSymbol,
        reason: 'STATIC_LIQUIDATION_WAIT',
        symbols: [...symbols],
      })
      .catch((error: unknown) => {
        logger.error(
          '[MonitorQuoteEventRuntime] 注册静态清仓 quote retain 失败',
          formatError(error),
        );
      });
  }

  /**
   * 清理 route 持有的一次性 retry timer。
   *
   * @param routeState route 状态
   */
  function clearRouteRetryTimer(routeState: MonitorQuoteRouteState): void {
    if (routeState.retryTimerHandle === null) {
      return;
    }

    clearTimer(routeState.retryTimerHandle);
    routeState.retryTimerHandle = null;
  }

  /**
   * 按 WAIT 结果重建静态清仓 route 的显式 wakeup 与 retry timer。
   *
   * @param monitorSymbol 监控标的
   * @param executionResult 本轮静态清仓执行结果
   */
  function updateStaticLiquidationWaitState(
    monitorSymbol: string,
    executionResult: Extract<StaticLiquidationRuntimeResult, { kind: 'WAIT' }>,
  ): void {
    const routeState = routeStates.get(monitorSymbol);
    if (!routeState) {
      return;
    }

    clearRouteRetryTimer(routeState);
    if (!running) {
      routeState.wakeupSymbols = new Set();
      releaseStaticLiquidationRetain(monitorSymbol);
      return;
    }

    routeState.wakeupSymbols = new Set(executionResult.wakeupSymbols);
    retainStaticLiquidationSymbols(monitorSymbol, routeState.wakeupSymbols);
    if (executionResult.retryAtMs === null) {
      return;
    }

    const delayMs = Math.max(0, executionResult.retryAtMs - (deps.now?.() ?? new Date()).getTime());
    routeState.retryTimerHandle = scheduleTimer(() => {
      routeState.retryTimerHandle = null;
      triggerRoute(monitorSymbol);
    }, delayMs);
  }

  /**
   * 判断 runtime 是否仍处于运行态。
   *
   * @returns runtime 仍在运行时返回 true
   */
  function isRuntimeRunning(): boolean {
    return running;
  }

  /**
   * 触发某个 monitor route 的 latest-only 执行。
   *
   * @param monitorSymbol 监控标的
   */
  function triggerRoute(monitorSymbol: string): void {
    const routeState = routeStates.get(monitorSymbol);
    if (!routeState || !running) {
      return;
    }

    routeState.dirty = true;
    if (routeState.inFlight) {
      return;
    }

    routeState.inFlight = true;
    const processingPromise = processRouteQueue(monitorSymbol);
    registerInFlight(processingPromise);
  }

  /**
   * 执行单轮 freshness 门禁等待。
   *
   * @returns 是否可以继续执行
   */
  async function waitForExecutionFreshness(): Promise<boolean> {
    if (!isExecutionGateOpen(deps) || !isBaselineReady(deps)) {
      return false;
    }

    if (!deps.postTradeConsistencyRuntime) {
      return true;
    }

    try {
      await deps.postTradeConsistencyRuntime.waitForFresh();
    } catch (error) {
      if (isStopAndDrainAbortError(error)) {
        return false;
      }

      throw error;
    }

    return isExecutionGateOpen(deps) && isBaselineReady(deps);
  }

  /**
   * 处理单个 monitor route 的 latest-only 队列。
   *
   * @param monitorSymbol 监控标的
   */
  async function processRouteQueue(monitorSymbol: string): Promise<void> {
    const routeState = routeStates.get(monitorSymbol);
    if (!routeState) {
      return;
    }

    try {
      while (routeState.dirty) {
        if (!running) {
          return;
        }

        routeState.dirty = false;
        const snapshotEvent = routeState.latestEvent;
        const latestMonitorContext =
          monitorContexts?.get(monitorSymbol) ?? routeState.latestMonitorContext;
        if (!snapshotEvent || !latestMonitorContext) {
          routeStates.delete(monitorSymbol);
          return;
        }

        routeState.latestMonitorContext = latestMonitorContext;

        const canExecute = await waitForExecutionFreshness();
        if (!canExecute) {
          return;
        }

        if (routeState.mode === 'DISTANCE_SWITCH') {
          if (!startDistanceSwitch) {
            continue;
          }

          const results = await startDistanceSwitch({
            monitorContext: latestMonitorContext,
            event: snapshotEvent,
          });

          for (const result of results) {
            if (
              isRuntimeRunning() &&
              handoffPendingSwitch &&
              result.started &&
              result.driveResult.kind === 'WAIT'
            ) {
              handoffPendingSwitch({
                monitorSymbol,
                direction: result.direction,
                monitorContext: latestMonitorContext,
                driveResult: result.driveResult,
              });
            }
          }

          continue;
        }

        if (!executeStaticLiquidation) {
          continue;
        }

        const executionResult = await executeStaticLiquidation({
          monitorContext: latestMonitorContext,
          event: snapshotEvent,
          retryAttempts: routeState.retryAttempts,
        });

        if (executionResult.kind === 'WAIT') {
          routeState.retryAttempts += 1;
          updateStaticLiquidationWaitState(monitorSymbol, executionResult);
          continue;
        }

        clearRouteRetryTimer(routeState);
        releaseStaticLiquidationRetain(monitorSymbol);
        routeState.wakeupSymbols = new Set();
        routeState.retryAttempts = 0;
      }
    } finally {
      const latestState = routeStates.get(monitorSymbol);
      if (latestState) {
        latestState.inFlight = false;
        if (latestState.dirty && running) {
          latestState.inFlight = true;
          const processingPromise = processRouteQueue(monitorSymbol);
          registerInFlight(processingPromise);
        }
      }
    }
  }

  /**
   * 处理单条 quote 事件。
   *
   * @param event 标准化 quote 事件
   */
  function handleQuoteUpdated(event: QuoteUpdatedEvent): void {
    if (!running || !monitorContexts) {
      return;
    }

    const eventMonitorContext = getMonitorContextForQuoteEvent({
      monitorContexts,
      event,
    });
    if (eventMonitorContext) {
      const mode: MonitorQuoteRouteMode = eventMonitorContext.config.autoSearchConfig
        .autoSearchEnabled
        ? 'DISTANCE_SWITCH'
        : 'STATIC_LIQUIDATION';
      const routeState = getOrCreateRouteState(eventMonitorContext.config.monitorSymbol, mode);
      routeState.latestMonitorContext = eventMonitorContext;
      routeState.latestEvent = event;
      if (mode === 'STATIC_LIQUIDATION') {
        clearRouteRetryTimer(routeState);
      }

      triggerRoute(eventMonitorContext.config.monitorSymbol);
    }

    for (const [monitorSymbol, routeState] of routeStates) {
      if (monitorSymbol === eventMonitorContext?.config.monitorSymbol) {
        continue;
      }

      if (!routeState.wakeupSymbols.has(event.symbol)) {
        continue;
      }

      const latestMonitorContext =
        monitorContexts.get(monitorSymbol) ?? routeState.latestMonitorContext;
      if (!latestMonitorContext) {
        releaseStaticLiquidationRetain(monitorSymbol);
        routeStates.delete(monitorSymbol);
        continue;
      }

      routeState.latestMonitorContext = latestMonitorContext;
      routeState.latestEvent = event;
      clearRouteRetryTimer(routeState);
      triggerRoute(monitorSymbol);
    }
  }

  function start(): void {
    if (running) {
      return;
    }

    running = true;
    unsubscribeQuoteUpdated = marketDataClient.onQuoteUpdated(handleQuoteUpdated);
  }

  async function stopAndDrain(): Promise<void> {
    running = false;
    unsubscribeQuoteUpdated?.();
    unsubscribeQuoteUpdated = null;

    for (const [monitorSymbol, routeState] of routeStates) {
      clearRouteRetryTimer(routeState);
      releaseStaticLiquidationRetain(monitorSymbol);
      routeState.wakeupSymbols = new Set();
    }

    if (activePromises.size > 0) {
      await Promise.allSettled(activePromises);
    }

    for (const [monitorSymbol, routeState] of routeStates) {
      clearRouteRetryTimer(routeState);
      releaseStaticLiquidationRetain(monitorSymbol);
      routeState.wakeupSymbols = new Set();
    }

    routeStates.clear();
  }

  return {
    start,
    stopAndDrain,
  };
}

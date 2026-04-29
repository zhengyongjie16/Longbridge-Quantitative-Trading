/**
 * SwitchWakeupRuntime
 *
 * 职责：
 * - 接管已启动 pending switch 的后续推进 owner
 * - 监听 ORDER_EVENT / FRESHNESS / SYMBOL_QUOTE / RETRY_TIMER 四类显式唤醒源
 * - 每次唤醒时重新读取权威快照，并以 single-flight + latest-only collapse 推进 advancePendingSwitch
 * - 以 monitorSymbol + direction + seatVersion 作为 route key，确保旧 seatVersion 注册自然失效
 */
import { isWithinDoomsdayClearanceTakeoverWindow } from '../../core/doomsdayProtection/utils.js';
import { formatError } from '../../utils/error/index.js';
import { logger } from '../../utils/logger/index.js';
import type { SwitchDriveResult } from '../../types/monitorContextPorts.js';
import type {
  SwitchWakeupHandoffParams,
  SwitchWakeupRoute,
  SwitchWakeupRouteKey,
  SwitchWakeupRouteState,
  SwitchWakeupRuntime,
  SwitchWakeupRuntimeDeps,
} from './types.js';

/**
 * 构造 route key。
 *
 * @param params 监控标的、方向与 seatVersion
 * @returns route key
 */
function buildRouteKey(params: {
  readonly monitorSymbol: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly seatVersion: number;
}): SwitchWakeupRouteKey {
  return `${params.monitorSymbol}:${params.direction}:${params.seatVersion}`;
}

/**
 * 判断 drive result 是否为 WAIT。
 *
 * @param driveResult 单步推进结果
 * @returns WAIT 时返回 true
 */
function isWaitDriveResult(
  driveResult: SwitchDriveResult,
): driveResult is Extract<SwitchDriveResult, { kind: 'WAIT' }> {
  return driveResult.kind === 'WAIT';
}

/**
 * 判断当前 freshness baseline 是否已经 ready。
 *
 * @param deps runtime 依赖
 * @returns 启动且 currentVersion 追平 staleVersion 时返回 true
 */
function isBaselineReady(deps: SwitchWakeupRuntimeDeps): boolean {
  const status = deps.postTradeConsistencyRuntime.getStatus();
  return status.started && status.currentVersion === status.staleVersion;
}

/**
 * 判断当前 lifecycle/runtime gate 是否允许推进 pending switch。
 *
 * @param deps runtime 依赖
 * @returns 可推进时返回 true
 */
function isExecutionGateOpen(deps: SwitchWakeupRuntimeDeps): boolean {
  if (!deps.lastState.isTradingEnabled || deps.lastState.canTrade !== true) {
    return false;
  }

  if (!deps.doomsdayProtectionEnabled) {
    return true;
  }

  return !isWithinDoomsdayClearanceTakeoverWindow(deps.now(), deps.lastState.isHalfDay ?? false);
}

/**
 * 创建 route 执行状态。
 *
 * @param route 当前 route
 * @returns 初始状态
 */
function createRouteState(route: SwitchWakeupRoute): SwitchWakeupRouteState {
  return {
    route,
    inFlight: false,
    dirty: false,
    wakeups: [],
    retryTimerHandle: null,
    retainedQuoteSymbols: new Set<string>(),
  };
}

/**
 * 提取当前 WAIT 结果中依赖 symbol quote 唤醒的标的集合。
 *
 * @param driveResult 单步推进结果
 * @returns 需要在等待期间保留订阅的标的集合
 */
function collectSymbolQuoteWakeupSymbols(driveResult: SwitchDriveResult): ReadonlySet<string> {
  if (!isWaitDriveResult(driveResult)) {
    return new Set<string>();
  }

  return new Set(
    driveResult.wakeups
      .filter((wakeup) => wakeup.kind === 'SYMBOL_QUOTE')
      .map((wakeup) => wakeup.symbol)
      .filter((symbol) => symbol.length > 0),
  );
}

/**
 * 判断两个 symbol 集合是否相同。
 *
 * @param left 左侧集合
 * @param right 右侧集合
 * @returns 元素完全一致时返回 true
 */
function areSymbolSetsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }

  for (const symbol of left) {
    if (!right.has(symbol)) {
      return false;
    }
  }

  return true;
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
 * 将 routeKey 注册到指定 symbol 的反向唤醒索引。
 *
 * @param index quote 或订单 symbol 到 routeKey 的反向索引
 * @param symbol 可唤醒 route 的业务 symbol
 * @param routeKey 被唤醒的 route key
 */
function addRouteKeyToSymbolIndex(
  index: Map<string, Set<SwitchWakeupRouteKey>>,
  symbol: string,
  routeKey: SwitchWakeupRouteKey,
): void {
  const routeKeys = index.get(symbol) ?? new Set<SwitchWakeupRouteKey>();
  routeKeys.add(routeKey);
  index.set(symbol, routeKeys);
}

/**
 * 从指定 symbol 的反向唤醒索引移除 routeKey。
 *
 * @param index quote 或订单 symbol 到 routeKey 的反向索引
 * @param symbol 曾注册的业务 symbol
 * @param routeKey 需要解除唤醒关系的 route key
 */
function removeRouteKeyFromSymbolIndex(
  index: Map<string, Set<SwitchWakeupRouteKey>>,
  symbol: string,
  routeKey: SwitchWakeupRouteKey,
): void {
  const routeKeys = index.get(symbol);
  if (routeKeys === undefined) {
    return;
  }

  routeKeys.delete(routeKey);
  if (routeKeys.size === 0) {
    index.delete(symbol);
  }
}

/**
 * 创建 SwitchWakeupRuntime。
 *
 * @param deps 事件源、权威快照依赖与 timer 能力
 * @returns runtime 实例
 */
export function createSwitchWakeupRuntime(deps: SwitchWakeupRuntimeDeps): SwitchWakeupRuntime {
  let running = false;
  let unsubscribeQuoteUpdated: (() => void) | null = null;
  let unsubscribeOrderStateChanged: (() => void) | null = null;
  let unsubscribeFreshReached: (() => void) | null = null;
  const routeStates = new Map<SwitchWakeupRouteKey, SwitchWakeupRouteState>();
  const quoteWakeupsBySymbol = new Map<string, Set<SwitchWakeupRouteKey>>();
  const orderWakeupsBySymbol = new Map<string, Set<SwitchWakeupRouteKey>>();
  const activeRoutePromises = new Set<Promise<void>>();

  /**
   * 取消指定 route 当前持有的 retry timer。
   *
   * @param routeState route 状态
   */
  function clearRetryTimer(routeState: SwitchWakeupRouteState): void {
    if (routeState.retryTimerHandle === null) {
      return;
    }

    deps.clearTimer(routeState.retryTimerHandle);
    routeState.retryTimerHandle = null;
  }

  /**
   * 释放指定 route 持有的 switch quote retain。
   *
   * @param routeKey 路由键
   */
  function releaseSwitchWakeupRetain(routeKey: SwitchWakeupRouteKey): void {
    const quoteSubscriptionRuntime = deps.quoteSubscriptionRuntime;
    const routeState = routeStates.get(routeKey);
    if (routeState !== undefined) {
      if (routeState.retainedQuoteSymbols.size === 0) {
        return;
      }

      routeState.retainedQuoteSymbols = new Set<string>();
    }

    if (quoteSubscriptionRuntime === undefined) {
      return;
    }

    void quoteSubscriptionRuntime
      .releaseRetain({
        ownerKey: routeKey,
        reason: 'SWITCH_WAKEUP',
      })
      .catch((error: unknown) => {
        logger.error('[SwitchWakeupRuntime] 释放 quote retain 失败', formatError(error));
      });
  }

  /**
   * 按最新 WAIT quote wakeup 集合刷新 route retain。
   *
   * @param routeKey 路由键
   * @param symbols 等待 quote 唤醒期间必须保留订阅的标的
   */
  function retainSwitchWakeupSymbols(
    routeKey: SwitchWakeupRouteKey,
    symbols: ReadonlySet<string>,
  ): void {
    const routeState = routeStates.get(routeKey);
    if (routeState === undefined) {
      return;
    }

    if (areSymbolSetsEqual(routeState.retainedQuoteSymbols, symbols)) {
      return;
    }

    routeState.retainedQuoteSymbols = new Set(symbols);
    const quoteSubscriptionRuntime = deps.quoteSubscriptionRuntime;
    if (quoteSubscriptionRuntime === undefined) {
      return;
    }

    if (symbols.size === 0) {
      releaseSwitchWakeupRetain(routeKey);
      return;
    }

    void quoteSubscriptionRuntime
      .retainSymbols({
        ownerKey: routeKey,
        reason: 'SWITCH_WAKEUP',
        symbols: [...symbols],
      })
      .catch((error: unknown) => {
        logger.error('[SwitchWakeupRuntime] 注册 quote retain 失败', formatError(error));
      });
  }

  /**
   * 移除指定 route 当前持有的全部显式唤醒索引。
   *
   * @param routeKey 需要清理唤醒索引的 route key
   */
  function removeRouteWakeupIndexes(routeKey: SwitchWakeupRouteKey): void {
    const routeState = routeStates.get(routeKey);
    if (routeState === undefined) {
      return;
    }

    for (const wakeup of routeState.wakeups) {
      if (wakeup.kind === 'SYMBOL_QUOTE') {
        removeRouteKeyFromSymbolIndex(quoteWakeupsBySymbol, wakeup.symbol, routeKey);
        continue;
      }

      if (wakeup.kind === 'ORDER_EVENT') {
        for (const symbol of wakeup.symbols) {
          removeRouteKeyFromSymbolIndex(orderWakeupsBySymbol, symbol, routeKey);
        }
      }
    }
  }

  /**
   * 按指定 route 当前 WAIT wakeups 重建显式唤醒索引。
   *
   * @param routeKey 需要注册唤醒索引的 route key
   */
  function registerRouteWakeupIndexes(routeKey: SwitchWakeupRouteKey): void {
    const routeState = routeStates.get(routeKey);
    if (routeState === undefined) {
      return;
    }

    for (const wakeup of routeState.wakeups) {
      if (wakeup.kind === 'SYMBOL_QUOTE') {
        addRouteKeyToSymbolIndex(quoteWakeupsBySymbol, wakeup.symbol, routeKey);
        continue;
      }

      if (wakeup.kind === 'ORDER_EVENT') {
        for (const symbol of wakeup.symbols) {
          addRouteKeyToSymbolIndex(orderWakeupsBySymbol, symbol, routeKey);
        }
      }
    }
  }

  /**
   * 删除 route 状态并清理其 timer。
   *
   * @param routeKey 路由键
   */
  function deleteRoute(routeKey: SwitchWakeupRouteKey): void {
    const routeState = routeStates.get(routeKey);
    if (routeState === undefined) {
      return;
    }

    clearRetryTimer(routeState);
    removeRouteWakeupIndexes(routeKey);
    releaseSwitchWakeupRetain(routeKey);
    routeStates.delete(routeKey);
  }

  /**
   * 按 monitor+direction 清理旧版本 route，只保留当前 handoff 的 seatVersion。
   *
   * @param nextRoute 新 route
   */
  function pruneOlderSeatVersions(nextRoute: SwitchWakeupRoute): void {
    for (const [routeKey, routeState] of routeStates) {
      if (routeKey === nextRoute.routeKey) {
        continue;
      }

      if (
        routeState.route.monitorSymbol === nextRoute.monitorSymbol &&
        routeState.route.direction === nextRoute.direction
      ) {
        deleteRoute(routeKey);
      }
    }
  }

  /**
   * 读取当前 route 仍是否与权威快照一致。
   *
   * @param route route 快照
   * @returns 当前仍有效时返回 true
   */
  function isRouteCurrent(route: SwitchWakeupRoute): boolean {
    const monitorContext = deps.monitorContexts.get(route.monitorSymbol);
    if (monitorContext === undefined) {
      return false;
    }

    const seatVersion = deps.symbolRegistry.getSeatVersion(route.monitorSymbol, route.direction);
    if (seatVersion !== route.seatVersion) {
      return false;
    }

    if (!monitorContext.autoSymbolManager.hasPendingSwitch(route.direction)) {
      return false;
    }

    return true;
  }

  /**
   * 获取当前权威 route；若已失效则返回 null。
   *
   * @param routeState route 状态
   * @returns 权威 route 或 null
   */
  function resolveAuthoritativeRoute(routeState: SwitchWakeupRouteState): SwitchWakeupRoute | null {
    const monitorContext = deps.monitorContexts.get(routeState.route.monitorSymbol);
    if (monitorContext === undefined) {
      return null;
    }

    const seatVersion = deps.symbolRegistry.getSeatVersion(
      routeState.route.monitorSymbol,
      routeState.route.direction,
    );
    if (seatVersion !== routeState.route.seatVersion) {
      return null;
    }

    if (!monitorContext.autoSymbolManager.hasPendingSwitch(routeState.route.direction)) {
      return null;
    }

    return {
      routeKey: routeState.route.routeKey,
      monitorSymbol: routeState.route.monitorSymbol,
      direction: routeState.route.direction,
      seatVersion: routeState.route.seatVersion,
      monitorContext,
    };
  }

  /**
   * 按 WAIT wakeups 重建当前 route 的显式注册。
   *
   * @param routeKey 路由键
   * @param driveResult 单步推进结果
   */
  function updateWakeups(routeKey: SwitchWakeupRouteKey, driveResult: SwitchDriveResult): void {
    const routeState = routeStates.get(routeKey);
    if (routeState === undefined) {
      return;
    }

    clearRetryTimer(routeState);
    removeRouteWakeupIndexes(routeKey);

    if (!running) {
      routeState.wakeups = [];
      releaseSwitchWakeupRetain(routeKey);
      return;
    }

    if (!isWaitDriveResult(driveResult)) {
      routeState.wakeups = [];
      releaseSwitchWakeupRetain(routeKey);
      return;
    }

    routeState.wakeups = [...driveResult.wakeups];
    registerRouteWakeupIndexes(routeKey);
    retainSwitchWakeupSymbols(routeKey, collectSymbolQuoteWakeupSymbols(driveResult));
    const retryWakeup = routeState.wakeups.find((wakeup) => wakeup.kind === 'RETRY_TIMER');
    if (retryWakeup === undefined) {
      return;
    }

    const delayMs = Math.max(0, retryWakeup.atMs - deps.now().getTime());
    routeState.retryTimerHandle = deps.scheduleTimer(() => {
      routeState.retryTimerHandle = null;
      triggerRoute(routeKey, 'RETRY_TIMER');
    }, delayMs);
  }

  /**
   * 统一触发 route 推进，复用 single-flight + latest-only collapse。
   *
   * @param routeKey 路由键
   * @param source 本次唤醒来源，仅用于日志
   */
  function triggerRoute(routeKey: SwitchWakeupRouteKey, source: string): void {
    const routeState = routeStates.get(routeKey);
    if (routeState === undefined || !running) {
      return;
    }

    routeState.dirty = true;
    if (routeState.inFlight) {
      return;
    }

    routeState.inFlight = true;
    const processingPromise = processRouteQueue(routeKey).catch((error: unknown) => {
      logger.error(
        `[SwitchWakeupRuntime] pending switch 推进失败 source=${source}`,
        formatError(error),
      );
    });
    activeRoutePromises.add(processingPromise);
    void processingPromise.finally(() => {
      activeRoutePromises.delete(processingPromise);
    });
  }

  /**
   * 处理单 route 的 latest-only 队列。
   *
   * 固定顺序：
   * 1. freshness 前 gate / baseline / current-route 校验
   * 2. waitForFresh
   * 3. freshness 后再次校验 gate / baseline / current-route
   * 4. 重新读取当前权威 positions
   * 5. 调用 advancePendingSwitch 推进一步，并重建显式 wakeups
   *
   * @param routeKey 路由键
   */
  async function processRouteQueue(routeKey: SwitchWakeupRouteKey): Promise<void> {
    const routeState = routeStates.get(routeKey);
    if (routeState === undefined) {
      return;
    }

    try {
      while (running && routeState.dirty) {
        routeState.dirty = false;

        if (!isExecutionGateOpen(deps) || !isBaselineReady(deps)) {
          return;
        }

        if (!isRouteCurrent(routeState.route)) {
          deleteRoute(routeKey);
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

        if (!isExecutionGateOpen(deps) || !isBaselineReady(deps)) {
          return;
        }

        const authoritativeRoute = resolveAuthoritativeRoute(routeState);
        if (authoritativeRoute === null) {
          deleteRoute(routeKey);
          return;
        }

        routeState.route = authoritativeRoute;

        const result =
          await authoritativeRoute.monitorContext.autoSymbolManager.advancePendingSwitch({
            direction: authoritativeRoute.direction,
            positions: deps.lastState.cachedPositions,
          });

        if (!result.advanced) {
          deleteRoute(routeKey);
          return;
        }

        if (!result.stillPending) {
          deleteRoute(routeKey);
          return;
        }

        updateWakeups(routeKey, result.driveResult);
      }
    } finally {
      const nextState = routeStates.get(routeKey);
      if (nextState !== undefined) {
        nextState.inFlight = false;
        if (nextState.dirty && running) {
          nextState.inFlight = true;
          const processingPromise = processRouteQueue(routeKey).catch((error: unknown) => {
            logger.error('[SwitchWakeupRuntime] pending switch 重入推进失败', formatError(error));
          });
          activeRoutePromises.add(processingPromise);
          void processingPromise.finally(() => {
            activeRoutePromises.delete(processingPromise);
          });
        }
      }
    }
  }

  /**
   * 处理 freshness 追平事件。
   */
  function handleFreshReached(): void {
    for (const [routeKey, routeState] of routeStates) {
      const matchesFreshness = routeState.wakeups.some((wakeup) => wakeup.kind === 'FRESHNESS');
      if (matchesFreshness) {
        triggerRoute(routeKey, 'FRESHNESS');
      }
    }
  }

  /**
   * 处理订单事件。
   *
   * @param symbol 本次订单事件关联 symbol
   */
  function handleOrderStateChanged(symbol: string | null): void {
    if (!running || symbol === null) {
      return;
    }

    const routeKeys = orderWakeupsBySymbol.get(symbol);
    if (routeKeys === undefined) {
      return;
    }

    for (const routeKey of routeKeys) {
      triggerRoute(routeKey, 'ORDER_EVENT');
    }
  }

  /**
   * 处理 quote 事件。
   *
   * @param symbol 行情 symbol
   */
  function handleQuoteUpdated(symbol: string): void {
    if (!running) {
      return;
    }

    const routeKeys = quoteWakeupsBySymbol.get(symbol);
    if (routeKeys === undefined) {
      return;
    }

    for (const routeKey of routeKeys) {
      triggerRoute(routeKey, 'SYMBOL_QUOTE');
    }
  }

  /**
   * 启动 runtime 并订阅三类事件源。
   */
  function start(): void {
    if (running) {
      return;
    }

    running = true;
    unsubscribeQuoteUpdated = deps.marketDataClient.onQuoteUpdated((event) => {
      handleQuoteUpdated(event.symbol);
    });

    unsubscribeOrderStateChanged = deps.trader.onOrderStateChanged((event) => {
      handleOrderStateChanged(event.symbol);
    });

    const subscribeFreshReached = deps.postTradeConsistencyRuntime.onFreshReached;
    unsubscribeFreshReached = subscribeFreshReached(() => {
      handleFreshReached();
    });
  }

  /**
   * 停止 runtime，取消所有注册并等待在途推进完成。
   */
  async function stopAndDrain(): Promise<void> {
    running = false;
    unsubscribeQuoteUpdated?.();
    unsubscribeQuoteUpdated = null;
    unsubscribeOrderStateChanged?.();
    unsubscribeOrderStateChanged = null;
    unsubscribeFreshReached?.();
    unsubscribeFreshReached = null;

    for (const routeState of routeStates.values()) {
      clearRetryTimer(routeState);
      removeRouteWakeupIndexes(routeState.route.routeKey);
      releaseSwitchWakeupRetain(routeState.route.routeKey);
    }

    quoteWakeupsBySymbol.clear();
    orderWakeupsBySymbol.clear();

    if (activeRoutePromises.size > 0) {
      await Promise.allSettled(activeRoutePromises);
    }

    for (const routeState of routeStates.values()) {
      clearRetryTimer(routeState);
      removeRouteWakeupIndexes(routeState.route.routeKey);
      routeState.wakeups = [];
      releaseSwitchWakeupRetain(routeState.route.routeKey);
    }

    quoteWakeupsBySymbol.clear();
    orderWakeupsBySymbol.clear();
    routeStates.clear();
  }

  /**
   * 把旧 owner 返回的 WAIT driveResult 交给 runtime 接管。
   *
   * @param params handoff 参数
   */
  function handoffPendingSwitch(params: SwitchWakeupHandoffParams): void {
    if (!running || !isWaitDriveResult(params.driveResult)) {
      return;
    }

    const authoritativeMonitorContext = deps.monitorContexts.get(params.monitorSymbol);
    if (
      authoritativeMonitorContext === undefined ||
      authoritativeMonitorContext !== params.monitorContext
    ) {
      return;
    }

    const seatVersion = params.monitorContext.symbolRegistry.getSeatVersion(
      params.monitorSymbol,
      params.direction,
    );
    const route: SwitchWakeupRoute = {
      routeKey: buildRouteKey({
        monitorSymbol: params.monitorSymbol,
        direction: params.direction,
        seatVersion,
      }),
      monitorSymbol: params.monitorSymbol,
      direction: params.direction,
      seatVersion,
      monitorContext: params.monitorContext,
    };

    pruneOlderSeatVersions(route);

    const existingState = routeStates.get(route.routeKey);
    const routeState = existingState ?? createRouteState(route);
    routeState.route = route;
    routeStates.set(route.routeKey, routeState);
    updateWakeups(route.routeKey, params.driveResult);
  }

  return {
    start,
    stopAndDrain,
    handoffPendingSwitch,
  };
}

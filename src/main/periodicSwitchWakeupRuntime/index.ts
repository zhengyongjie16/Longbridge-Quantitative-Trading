/**
 * PeriodicSwitchWakeupRuntime
 *
 * 职责：
 * - 接管 ACTIVE seat 周期换标 due timer 的唯一 ownership
 * - 基于 seat truth baseline 隔离旧 timer、旧 waiting-empty 与旧任务回调
 * - 通过 AUTO_SYMBOL_TICK latest-only 任务推进周期换标，不向 timeWakeupPlanner 暴露候选
 */
import type { MonitorTaskInput } from '../asyncProgram/monitorTaskQueue/types.js';
import type { MonitorTaskDataMap } from '../asyncProgram/monitorTaskProcessor/types.js';
import type { TradingGateStateChangedEvent } from '../tradingGateEventRuntime/types.js';
import type {
  PeriodicSwitchAutoSymbolTickTaskData,
  PeriodicSwitchDirection,
  PeriodicSwitchRoute,
  PeriodicSwitchRouteBaseline,
  PeriodicSwitchRouteState,
  PeriodicSwitchWakeupRuntime,
  PeriodicSwitchWakeupRuntimeDeps,
} from './types.js';

function buildRouteKey(route: PeriodicSwitchRoute): string {
  return `${route.monitorSymbol}:${route.direction}`;
}

function baselineMatches(
  left: PeriodicSwitchRouteBaseline,
  right: PeriodicSwitchRouteBaseline,
): boolean {
  return (
    left.monitorSymbol === right.monitorSymbol &&
    left.direction === right.direction &&
    left.symbol === right.symbol &&
    left.seatVersion === right.seatVersion &&
    left.lastSeatActivatedAt === right.lastSeatActivatedAt
  );
}

function isValidSeatVersion(seatVersion: number): boolean {
  return Number.isSafeInteger(seatVersion) && seatVersion > 0;
}

function getPeriodicSwitchDirections(): ReadonlyArray<PeriodicSwitchDirection> {
  return ['LONG', 'SHORT'];
}

/**
 * 创建周期换标唤醒 runtime。
 *
 * @param deps runtime 依赖
 * @returns PeriodicSwitchWakeupRuntime 实例
 */
export function createPeriodicSwitchWakeupRuntime(
  deps: PeriodicSwitchWakeupRuntimeDeps,
): PeriodicSwitchWakeupRuntime {
  let running = false;
  let unsubscribeSeatTruthChanged: (() => void) | null = null;
  let unsubscribeOrderStateChanged: (() => void) | null = null;
  let unsubscribeFreshReached: (() => void) | null = null;
  let unsubscribeGateStateChanged: (() => void) | null = null;
  const routeStates = new Map<string, PeriodicSwitchRouteState>();

  function getRouteState(route: PeriodicSwitchRoute): PeriodicSwitchRouteState {
    const routeKey = buildRouteKey(route);
    const currentState = routeStates.get(routeKey);
    if (currentState !== undefined) {
      return currentState;
    }

    const nextState: PeriodicSwitchRouteState = {
      baseline: null,
      timerHandle: null,
      waitingEmpty: null,
    };
    routeStates.set(routeKey, nextState);
    return nextState;
  }

  function clearRouteTimer(route: PeriodicSwitchRoute): void {
    const state = routeStates.get(buildRouteKey(route));
    if (state?.timerHandle === null || state === undefined) {
      return;
    }

    deps.clearTimer(state.timerHandle);
    state.timerHandle = null;
  }

  function readCurrentBaseline(route: PeriodicSwitchRoute): PeriodicSwitchRouteBaseline | null {
    const monitorContext = deps.monitorContexts.get(route.monitorSymbol);
    if (monitorContext === undefined) {
      return null;
    }

    const autoSearchConfig = monitorContext.config.autoSearchConfig;
    if (!autoSearchConfig.autoSearchEnabled || autoSearchConfig.switchIntervalMinutes <= 0) {
      return null;
    }

    const seatState = deps.symbolRegistry.getSeatState(route.monitorSymbol, route.direction);
    const seatVersion = deps.symbolRegistry.getSeatVersion(route.monitorSymbol, route.direction);
    if (
      seatState.status !== 'ACTIVE' ||
      seatState.symbol === null ||
      seatState.lastSeatActivatedAt === null ||
      !Number.isFinite(seatState.lastSeatActivatedAt) ||
      !isValidSeatVersion(seatVersion)
    ) {
      return null;
    }

    return {
      monitorSymbol: route.monitorSymbol,
      direction: route.direction,
      symbol: seatState.symbol,
      seatVersion,
      lastSeatActivatedAt: seatState.lastSeatActivatedAt,
    };
  }

  function getSwitchIntervalMinutes(route: PeriodicSwitchRoute): number | null {
    const monitorContext = deps.monitorContexts.get(route.monitorSymbol);
    if (monitorContext === undefined) {
      return null;
    }

    const switchIntervalMinutes = monitorContext.config.autoSearchConfig.switchIntervalMinutes;
    if (switchIntervalMinutes <= 0) {
      return null;
    }

    return switchIntervalMinutes;
  }

  function dispatchAutoSymbolTick(baseline: PeriodicSwitchRouteBaseline): void {
    const currentTimeMs = deps.now().getTime();
    const data: PeriodicSwitchAutoSymbolTickTaskData = {
      monitorSymbol: baseline.monitorSymbol,
      direction: baseline.direction,
      seatVersion: baseline.seatVersion,
      symbol: baseline.symbol,
      lastSeatActivatedAt: baseline.lastSeatActivatedAt,
      currentTimeMs,
    };
    const task: MonitorTaskInput<MonitorTaskDataMap, 'AUTO_SYMBOL_TICK'> = {
      type: 'AUTO_SYMBOL_TICK',
      dedupeKey: `${baseline.monitorSymbol}:AUTO_SYMBOL_TICK:${baseline.direction}`,
      monitorSymbol: baseline.monitorSymbol,
      data,
    };

    deps.monitorTaskQueue.scheduleLatest(task);
  }

  function invalidateRouteIfBaselineChanged(
    route: PeriodicSwitchRoute,
    nextBaseline: PeriodicSwitchRouteBaseline | null,
  ): PeriodicSwitchRouteState {
    const state = getRouteState(route);
    const currentBaseline = state.baseline;
    const baselineChanged =
      currentBaseline !== null &&
      (nextBaseline === null || !baselineMatches(currentBaseline, nextBaseline));

    if (baselineChanged) {
      clearRouteTimer(route);
      state.waitingEmpty = null;
    }

    state.baseline = nextBaseline;
    return state;
  }

  /**
   * 对单 route 重新读取权威 truth 并安排一次 due 行为。
   * baseline 不完整或 dueAtMs 为 null 时只清理旧派生状态，不做 fallback。
   */
  function planRoute(route: PeriodicSwitchRoute): void {
    if (!running) {
      return;
    }

    const baseline = readCurrentBaseline(route);
    const state = invalidateRouteIfBaselineChanged(route, baseline);
    if (baseline === null || state.waitingEmpty !== null) {
      return;
    }

    const switchIntervalMinutes = getSwitchIntervalMinutes(route);
    if (switchIntervalMinutes === null) {
      return;
    }

    const dueAtMs = deps.calculateDueAtMs({
      startMs: baseline.lastSeatActivatedAt,
      switchIntervalMinutes,
    });
    if (dueAtMs === null) {
      clearRouteTimer(route);
      return;
    }

    const nowMs = deps.now().getTime();
    if (dueAtMs <= nowMs) {
      clearRouteTimer(route);
      dispatchAutoSymbolTick(baseline);
      return;
    }

    clearRouteTimer(route);
    state.timerHandle = deps.scheduleTimer(() => {
      state.timerHandle = null;
      if (!running) {
        return;
      }

      const currentBaseline = readCurrentBaseline(route);
      if (currentBaseline !== null && baselineMatches(currentBaseline, baseline)) {
        dispatchAutoSymbolTick(baseline);
      }
    }, dueAtMs - nowMs);
  }

  function seedRoutes(): void {
    for (const monitorConfig of deps.tradingConfig.monitors) {
      for (const direction of getPeriodicSwitchDirections()) {
        planRoute({ monitorSymbol: monitorConfig.monitorSymbol, direction });
      }
    }
  }

  function handleSeatTruthChanged(event: PeriodicSwitchRoute): void {
    planRoute({ monitorSymbol: event.monitorSymbol, direction: event.direction });
  }

  function redispatchWaitingEmptyRoutes(): void {
    if (!running) {
      return;
    }

    for (const [routeKey, state] of routeStates) {
      const waitingBaseline = state.waitingEmpty;
      if (waitingBaseline === null) {
        continue;
      }

      const currentBaseline = readCurrentBaseline(waitingBaseline);
      if (currentBaseline === null || !baselineMatches(currentBaseline, waitingBaseline)) {
        routeStates.delete(routeKey);
        continue;
      }

      dispatchAutoSymbolTick(waitingBaseline);
    }
  }

  function handleGateStateChanged(event: TradingGateStateChangedEvent): void {
    if (event.previousCanTrade === true || !event.nextCanTrade) {
      return;
    }

    for (const monitorConfig of deps.tradingConfig.monitors) {
      for (const direction of getPeriodicSwitchDirections()) {
        const route = { monitorSymbol: monitorConfig.monitorSymbol, direction };
        const state = routeStates.get(buildRouteKey(route));
        if (state !== undefined && state.waitingEmpty !== null) {
          continue;
        }

        planRoute(route);
      }
    }
  }

  function markWaitingEmpty(baseline: PeriodicSwitchRouteBaseline): void {
    if (!running) {
      return;
    }

    const currentBaseline = readCurrentBaseline(baseline);
    if (currentBaseline === null || !baselineMatches(currentBaseline, baseline)) {
      return;
    }

    const state = getRouteState(baseline);
    clearRouteTimer(baseline);
    state.baseline = baseline;
    state.waitingEmpty = baseline;
  }

  function scheduleTaskFailureRetry(baseline: PeriodicSwitchRouteBaseline): void {
    const state = getRouteState(baseline);
    clearRouteTimer(baseline);
    state.baseline = baseline;
    state.waitingEmpty = null;
    state.timerHandle = deps.scheduleTimer(() => {
      state.timerHandle = null;
      if (!running) {
        return;
      }

      const currentBaseline = readCurrentBaseline(baseline);
      if (currentBaseline !== null && baselineMatches(currentBaseline, baseline)) {
        dispatchAutoSymbolTick(baseline);
      }
    }, deps.taskFailureRetryDelayMs);
  }

  function clearWaitingEmpty(baseline: PeriodicSwitchRouteBaseline): void {
    const currentBaseline = readCurrentBaseline(baseline);
    if (currentBaseline === null || !baselineMatches(currentBaseline, baseline)) {
      return;
    }

    const state = routeStates.get(buildRouteKey(baseline));
    if (state !== undefined && state.waitingEmpty !== null) {
      state.waitingEmpty = null;
    }
  }

  function replanRouteAfterTask(
    params: Parameters<PeriodicSwitchWakeupRuntime['replanRouteAfterTask']>[0],
  ): void {
    if (!running) {
      return;
    }

    const baseline: PeriodicSwitchRouteBaseline = {
      monitorSymbol: params.monitorSymbol,
      direction: params.direction,
      symbol: params.symbol,
      seatVersion: params.seatVersion,
      lastSeatActivatedAt: params.lastSeatActivatedAt,
    };
    const currentBaseline = readCurrentBaseline(baseline);
    if (currentBaseline === null || !baselineMatches(currentBaseline, baseline)) {
      const state = routeStates.get(buildRouteKey(baseline));
      if (
        state?.baseline !== null &&
        state !== undefined &&
        baselineMatches(state.baseline, baseline)
      ) {
        clearRouteTimer(baseline);
        routeStates.delete(buildRouteKey(baseline));
      }

      return;
    }

    const state = invalidateRouteIfBaselineChanged(baseline, currentBaseline);
    if (params.status === 'failed') {
      scheduleTaskFailureRetry(baseline);
      return;
    }

    if (params.status === 'skipped' || params.status === 'blocked') {
      clearRouteTimer(baseline);
      state.waitingEmpty = null;
      return;
    }

    if (state.waitingEmpty !== null && baselineMatches(state.waitingEmpty, baseline)) {
      return;
    }

    state.waitingEmpty = null;
    const switchIntervalMinutes = getSwitchIntervalMinutes(baseline);
    if (switchIntervalMinutes === null) {
      return;
    }

    const dueAtMs = deps.calculateDueAtMs({
      startMs: baseline.lastSeatActivatedAt,
      switchIntervalMinutes,
    });
    if (dueAtMs === null || dueAtMs <= params.taskTimeMs) {
      clearRouteTimer(baseline);
      return;
    }

    planRoute(baseline);
  }

  function start(): void {
    if (running) {
      return;
    }

    running = true;
    unsubscribeSeatTruthChanged = deps.symbolRegistry.onSeatTruthChanged(handleSeatTruthChanged);
    unsubscribeOrderStateChanged = deps.trader.onOrderStateChanged(redispatchWaitingEmptyRoutes);
    unsubscribeFreshReached = deps.postTradeConsistencyRuntime.onFreshReached(
      redispatchWaitingEmptyRoutes,
    );

    unsubscribeGateStateChanged =
      deps.tradingGateEventRuntime.onGateStateChanged(handleGateStateChanged);
    seedRoutes();
  }

  function stopAndDrain(): Promise<void> {
    running = false;
    unsubscribeSeatTruthChanged?.();
    unsubscribeSeatTruthChanged = null;
    unsubscribeOrderStateChanged?.();
    unsubscribeOrderStateChanged = null;
    unsubscribeFreshReached?.();
    unsubscribeFreshReached = null;
    unsubscribeGateStateChanged?.();
    unsubscribeGateStateChanged = null;

    for (const state of routeStates.values()) {
      if (state.timerHandle !== null) {
        deps.clearTimer(state.timerHandle);
      }
    }

    routeStates.clear();
    return Promise.resolve();
  }

  return {
    start,
    stopAndDrain,
    markWaitingEmpty,
    clearWaitingEmpty,
    replanRouteAfterTask,
  };
}

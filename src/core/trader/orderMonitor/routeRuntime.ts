/**
 * orderMonitor route runtime 模块
 *
 * 职责：
 * - 订阅 quote 事件并按 trading symbol route 触发单航道处理
 * - 维护单 route 的 in-flight / dirty collapse 与 timer 投影执行语义
 * - 在 stopAndDrain 时取消订阅、清理 timer 并等待在途 route 执行完成
 */
import { OrderSide, OrderType } from 'longbridge';
import { ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS } from '../../../constants/index.js';
import { scheduleBoundedOneShotAt } from '../../../utils/timer/index.js';
import type { QuoteUpdatedEvent } from '../../../types/services.js';
import type { OrderMonitorConfig, TrackedOrder } from '../types.js';
import { clearRouteTimers } from './routingIndex.js';
import type {
  OrderMonitorSymbolRouteState,
  OrderMonitorTimerKey,
  OrderMonitorTimerKind,
  OrderMonitorTrackedOrder,
  OrderMonitorWakeupKind,
  RouteTimerSchedule,
  RouteRuntime,
  RouteRuntimeDeps,
} from './types.js';

const NATIVE_TIMER_NOW = (): Date => new Date(Date.now());

function scheduleNativeTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
  return setTimeout(callback, delayMs);
}

function clearNativeTimer(handle: ReturnType<typeof setTimeout>): void {
  clearTimeout(handle);
}

function resolveTimeoutTimerKind(side: TrackedOrder['side']): OrderMonitorTimerKind {
  if (side === OrderSide.Buy) {
    return 'BUY_TIMEOUT';
  }

  return 'SELL_TIMEOUT';
}

function resolveTimeoutSchedule(
  order: OrderMonitorTrackedOrder,
  config: OrderMonitorConfig,
): RouteTimerSchedule | null {
  if (order.convertedToMarket || order.orderType === OrderType.MO) {
    return null;
  }

  const timeoutConfig = order.side === OrderSide.Buy ? config.buyTimeout : config.sellTimeout;
  if (!timeoutConfig.enabled) {
    return null;
  }

  const atMs = order.submittedAt + timeoutConfig.timeoutMs;
  if (!Number.isFinite(atMs)) {
    return null;
  }

  return {
    key: `${order.orderId}:${resolveTimeoutTimerKind(order.side)}`,
    atMs,
  };
}

function resolveCancelRetrySchedule(order: OrderMonitorTrackedOrder): RouteTimerSchedule | null {
  const remainingQuantity = order.submittedQuantity - order.executedQuantity;
  if (remainingQuantity <= 0) {
    return null;
  }

  if (
    !Number.isFinite(order.nextCancelAttemptAt) ||
    order.nextCancelAttemptAt === ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS
  ) {
    return null;
  }

  return {
    key: `${order.orderId}:CANCEL_RETRY`,
    atMs: order.nextCancelAttemptAt,
  };
}

function resolveReplaceRetrySchedule(order: OrderMonitorTrackedOrder): RouteTimerSchedule | null {
  if (
    order.replaceCapability !== 'TEMP_BLOCKED_BY_STATUS' ||
    order.replaceBlockedUntilAt === null ||
    !Number.isFinite(order.replaceBlockedUntilAt) ||
    order.replaceBlockedUntilAt === ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS
  ) {
    return null;
  }

  return {
    key: `${order.orderId}:REPLACE_RETRY`,
    atMs: order.replaceBlockedUntilAt,
  };
}

function resolveQuoteRetrySchedule(order: OrderMonitorTrackedOrder): RouteTimerSchedule | null {
  if (order.quoteRetryNextAt === null || !Number.isFinite(order.quoteRetryNextAt)) {
    return null;
  }

  return {
    key: `${order.orderId}:QUOTE_RETRY`,
    atMs: order.quoteRetryNextAt,
  };
}

function resolveRouteTimerSchedules(
  order: OrderMonitorTrackedOrder,
  config: OrderMonitorConfig,
): ReadonlyArray<RouteTimerSchedule> {
  const schedules = [
    resolveTimeoutSchedule(order, config),
    resolveCancelRetrySchedule(order),
    resolveReplaceRetrySchedule(order),
    resolveQuoteRetrySchedule(order),
  ];

  return schedules.filter((schedule): schedule is RouteTimerSchedule => schedule !== null);
}

/**
 * 创建订单监控 route runtime。
 *
 * @param deps route runtime 依赖
 * @returns route runtime 实例
 */
export function createRouteRuntime(deps: RouteRuntimeDeps): RouteRuntime {
  const { runtime, config, marketDataClient, processRoute } = deps;
  const activeRoutePromises = new Set<Promise<void>>();
  let firstRouteProcessingError: Error | null = null;

  function isRouteRuntimeActive(): boolean {
    return runtime.running && runtime.runtimeState === 'ACTIVE';
  }

  function getRouteState(symbol: string): OrderMonitorSymbolRouteState | null {
    return runtime.routeStatesBySymbol.get(symbol) ?? null;
  }

  function launchRouteProcessing(symbol: string, wakeupKind: OrderMonitorWakeupKind): void {
    const routeState = getRouteState(symbol);
    if (routeState === null) {
      return;
    }

    const promise = runRoute(symbol, routeState.generation, wakeupKind);
    activeRoutePromises.add(promise);
    promise
      .finally(() => {
        activeRoutePromises.delete(promise);
      })
      .catch((error: unknown) => {
        if (firstRouteProcessingError === null && error instanceof Error) {
          firstRouteProcessingError = error;
        }
      });
  }

  function resetRouteStateForStop(routeState: OrderMonitorSymbolRouteState): void {
    clearRouteTimers(routeState);
    routeState.generation += 1;
    runtime.latestRouteGenerationBySymbol.set(routeState.symbol, routeState.generation);
    routeState.inFlight = false;
    routeState.dirty = false;
    routeState.latestQuote = null;
    routeState.pendingWakeupKind = null;
  }

  function reconcileRouteTimers(symbol: string, generation: number): void {
    const routeState = getRouteState(symbol);
    if (routeState?.generation !== generation) {
      return;
    }

    const desiredSchedules = new Map<OrderMonitorTimerKey, number>();
    const orderIds = runtime.trackedOrderIdsBySymbol.get(symbol);
    for (const orderId of orderIds ?? []) {
      const trackedOrder = runtime.trackedOrders.get(orderId);
      if (!trackedOrder) {
        continue;
      }

      for (const schedule of resolveRouteTimerSchedules(trackedOrder, config)) {
        desiredSchedules.set(schedule.key, schedule.atMs);
      }
    }

    for (const [timerKey, timerRegistration] of routeState.timerHandles.entries()) {
      const desiredAtMs = desiredSchedules.get(timerKey);
      if (desiredAtMs !== undefined && timerRegistration.atMs === desiredAtMs) {
        continue;
      }

      timerRegistration.handle.cancel();
      routeState.timerHandles.delete(timerKey);
    }

    for (const [timerKey, atMs] of desiredSchedules.entries()) {
      if (routeState.timerHandles.has(timerKey)) {
        continue;
      }

      const timerHandle = scheduleBoundedOneShotAt({
        atMs,
        now: NATIVE_TIMER_NOW,
        scheduleTimer: scheduleNativeTimer,
        clearTimer: clearNativeTimer,
        onDue: () => {
          const latestRouteState = getRouteState(symbol);
          if (latestRouteState?.generation !== generation) {
            return;
          }

          latestRouteState.timerHandles.delete(timerKey);
          triggerRoute(symbol, 'TIMER');
        },
      });
      routeState.timerHandles.set(timerKey, {
        atMs,
        handle: timerHandle,
      });
    }
  }

  /**
   * 执行一次 symbol route pass，并在 finally 中统一完成 dirty collapse 与 timer 投影。
   *
   * 这里故意把 timer reconcile、inFlight 复位和 dirty rerun 收口在同一个 finally：
   * - 避免 route 处理抛错后遗留错误的 inFlight/timer 状态
   * - 保证同一 generation 下最多只有一个在途 pass
   * - 保证 pass 期间累积的 wakeup 只会在 finally 统一折叠为下一次 rerun
   *
   * @param symbol route 对应的 symbol
   * @param generation 当前 route generation
   * @param wakeupKind 触发本次 pass 的 owner
   * @returns 无返回值
   */
  async function runRoute(
    symbol: string,
    generation: number,
    wakeupKind: OrderMonitorWakeupKind,
  ): Promise<void> {
    const routeState = getRouteState(symbol);
    if (routeState === null || !isRouteRuntimeActive() || routeState.generation !== generation) {
      return;
    }

    try {
      await processRoute({
        symbol,
        generation,
        wakeupKind,
        latestQuote: routeState.latestQuote,
      });
    } finally {
      reconcileRouteTimers(symbol, generation);
      const latestRouteState = getRouteState(symbol);
      if (latestRouteState !== null && latestRouteState.generation === generation) {
        latestRouteState.inFlight = false;
        if (!isRouteRuntimeActive()) {
          latestRouteState.dirty = false;
          latestRouteState.pendingWakeupKind = null;
        } else if (latestRouteState.dirty) {
          const rerunWakeupKind = latestRouteState.pendingWakeupKind;
          latestRouteState.dirty = false;
          latestRouteState.pendingWakeupKind = null;

          switch (rerunWakeupKind) {
            case 'QUOTE':
            case 'ORDER_EVENT':
            case 'TIMER':
            case 'TRACKED':
            case 'RECOVERED': {
              latestRouteState.inFlight = true;
              launchRouteProcessing(symbol, rerunWakeupKind);
              break;
            }

            case null: {
              break;
            }

            default: {
              break;
            }
          }
        }
      }
    }
  }

  /**
   * 触发 symbol route。
   *
   * 规则：若当前 route 已在执行，则只记录最新一次 wakeup 到 dirty/pendingWakeupKind，
   * 不并发启动第二个 pass；否则立即启动本轮处理。
   *
   * @param symbol route 对应的 symbol
   * @param wakeupKind 本次触发来源
   * @returns 无返回值
   */
  function triggerRoute(symbol: string, wakeupKind: OrderMonitorWakeupKind): void {
    const routeState = getRouteState(symbol);
    if (routeState === null || !isRouteRuntimeActive()) {
      return;
    }

    routeState.dirty = true;
    routeState.pendingWakeupKind = wakeupKind;
    if (routeState.inFlight) {
      return;
    }

    routeState.dirty = false;
    routeState.pendingWakeupKind = null;
    routeState.inFlight = true;
    launchRouteProcessing(symbol, wakeupKind);
  }

  /**
   * 为当前仍有 tracked orders 的 symbol 重新投递一次 recovered wakeup。
   *
   * 仅 runtime start 后允许调用，用于把恢复阶段已存在的订单重新接入事件驱动 route。
   *
   * @returns 无返回值
   */
  function bootstrapActiveRoutes(): void {
    if (!isRouteRuntimeActive()) {
      return;
    }

    for (const [symbol, orderIds] of runtime.trackedOrderIdsBySymbol.entries()) {
      if (orderIds.size === 0) {
        continue;
      }

      triggerRoute(symbol, 'RECOVERED');
    }
  }

  function handleQuoteUpdated(event: QuoteUpdatedEvent): void {
    const routeState = getRouteState(event.symbol);
    if (!isRouteRuntimeActive() || routeState === null) {
      return;
    }

    routeState.latestQuote = event.quote;
    triggerRoute(event.symbol, 'QUOTE');
  }

  function start(): void {
    if (runtime.running) {
      return;
    }

    firstRouteProcessingError = null;
    runtime.running = true;
    runtime.unsubscribeQuoteUpdated = marketDataClient.onQuoteUpdated((event) => {
      handleQuoteUpdated(event);
    });
    bootstrapActiveRoutes();
  }

  async function stopAndDrain(): Promise<void> {
    runtime.running = false;
    runtime.unsubscribeQuoteUpdated?.();
    runtime.unsubscribeQuoteUpdated = null;

    let stopError: Error | null = null;
    if (activeRoutePromises.size > 0) {
      const results = await Promise.allSettled(activeRoutePromises);
      for (const result of results) {
        if (result.status === 'rejected' && result.reason instanceof Error) {
          stopError = result.reason;
          break;
        }
      }
    }

    for (const routeState of runtime.routeStatesBySymbol.values()) {
      resetRouteStateForStop(routeState);
    }

    if (stopError !== null) {
      firstRouteProcessingError = null;
      throw stopError;
    }

    if (firstRouteProcessingError !== null) {
      const error = firstRouteProcessingError;
      firstRouteProcessingError = null;
      throw error;
    }
  }

  return {
    bootstrapActiveRoutes,
    start,
    stopAndDrain,
    triggerRoute,
  };
}

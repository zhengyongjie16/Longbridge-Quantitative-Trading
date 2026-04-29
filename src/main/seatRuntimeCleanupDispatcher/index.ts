/**
 * 席位运行态清理 dispatcher
 *
 * 职责：
 * - 监听 SymbolRegistry 的 seat state event
 * - 在席位从 ACTIVE 退出时清理该方向旧信号、旧任务与牛熊证缓存
 * - 保持席位清理从时间循环迁移到席位状态边沿事件
 */
import { logger } from '../../utils/logger/index.js';
import { clearMonitorDirectionQueues, logDirectionQueueCleanup } from './queueCleanup.js';
import type { SeatStateChangedEvent } from '../../types/seat.js';
import type { Unsubscribe } from '../../types/services.js';
import type { SeatRuntimeCleanupDispatcher, SeatRuntimeCleanupDispatcherDeps } from './types.js';

function shouldCleanupDirectionRuntime(event: SeatStateChangedEvent): boolean {
  return event.previousState.status === 'ACTIVE' && event.nextState.status !== 'ACTIVE';
}

function cleanupDirectionRuntime(
  deps: SeatRuntimeCleanupDispatcherDeps,
  event: SeatStateChangedEvent,
): void {
  const monitorContext = deps.monitorContexts.get(event.monitorSymbol);
  if (monitorContext === undefined) {
    throw new Error(
      `[SeatRuntimeCleanupDispatcher] 未找到监控上下文: monitorSymbol=${event.monitorSymbol} direction=${event.direction}`,
    );
  }

  if (event.direction === 'LONG') {
    monitorContext.riskChecker.clearLongWarrantInfo();
  } else {
    monitorContext.riskChecker.clearShortWarrantInfo();
  }

  const result = clearMonitorDirectionQueues({
    monitorSymbol: event.monitorSymbol,
    direction: event.direction,
    delayedSignalVerifier: monitorContext.delayedSignalVerifier,
    buyTaskQueue: deps.buyTaskQueue,
    sellTaskQueue: deps.sellTaskQueue,
    monitorTaskQueue: deps.monitorTaskQueue,
  });
  logDirectionQueueCleanup({
    source: '席位事件',
    monitorSymbol: event.monitorSymbol,
    direction: event.direction,
    result,
    logger,
  });
}

/**
 * 创建席位运行态清理 dispatcher。
 * 该 dispatcher 只消费 ACTIVE 退出的 seat state event，不在启动时扫描补偿历史状态。
 *
 * @param deps dispatcher 依赖
 * @returns SeatRuntimeCleanupDispatcher 实例
 */
export function createSeatRuntimeCleanupDispatcher(
  deps: SeatRuntimeCleanupDispatcherDeps,
): SeatRuntimeCleanupDispatcher {
  let unsubscribeSeatStateChanged: Unsubscribe | null = null;

  function handleSeatStateChanged(event: SeatStateChangedEvent): void {
    if (!shouldCleanupDirectionRuntime(event)) {
      return;
    }

    cleanupDirectionRuntime(deps, event);
  }

  function start(): void {
    if (unsubscribeSeatStateChanged !== null) {
      return;
    }

    unsubscribeSeatStateChanged = deps.symbolRegistry.onSeatStateChanged(handleSeatStateChanged);
  }

  function stop(): void {
    unsubscribeSeatStateChanged?.();
    unsubscribeSeatStateChanged = null;
  }

  return {
    start,
    stop,
  };
}

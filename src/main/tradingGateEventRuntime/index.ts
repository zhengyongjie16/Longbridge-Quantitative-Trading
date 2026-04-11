/**
 * TradingGateEventRuntime
 *
 * 职责：
 * - 将主循环已有连续交易门禁状态变化转为显式事件
 * - 为自动寻标事件 owner 提供 gate-open 唤醒来源
 */
import type { TradingGateEventRuntime, TradingGateStateChangedEvent } from './types.js';

/**
 * 创建交易门禁事件端口。
 *
 * @returns 可发布与订阅 gate state 变化的事件端口
 */
export function createTradingGateEventRuntime(): TradingGateEventRuntime {
  const listeners = new Set<(event: TradingGateStateChangedEvent) => void>();

  function emitGateStateChanged(event: TradingGateStateChangedEvent): void {
    for (const listener of listeners) {
      listener(event);
    }
  }

  function onGateStateChanged(listener: (event: TradingGateStateChangedEvent) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return {
    emitGateStateChanged,
    onGateStateChanged,
  };
}

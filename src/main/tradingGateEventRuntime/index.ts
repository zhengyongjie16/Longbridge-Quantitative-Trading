/**
 * TradingGateEventRuntime
 *
 * 职责：
 * - 将时间唤醒评估产生的连续交易门禁变化转为显式事件
 * - 为自动寻标事件 owner 提供 gate-open 唤醒来源
 */
import { formatError } from '../../utils/error/index.js';
import { logger } from '../../utils/logger/index.js';
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
      try {
        listener(event);
      } catch (error) {
        logger.error('[TradingGateEventRuntime] gate state listener 执行失败', formatError(error));
      }
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

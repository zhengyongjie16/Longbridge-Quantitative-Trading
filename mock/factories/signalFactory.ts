/**
 * 信号 Mock 工厂
 *
 * 功能：
 * - 按测试需求生成可定制字段的交易信号对象
 */
import type { Signal } from '../../src/types/signal.js';
import type { SignalFactoryParams } from './types.js';

/**
 * 按测试需求构造可定制字段的交易信号，未传字段使用默认值（如 reason、seatVersion、triggerTime）。
 */
export function createSignal(params: SignalFactoryParams): Signal {
  return {
    symbol: params.symbol,
    symbolName: params.symbol,
    action: params.action,
    reason: params.reason ?? 'mock-signal',
    seatVersion: params.seatVersion ?? 1,
    triggerTime: new Date(params.triggerTimeMs ?? Date.now()),
    ...(params.price === undefined ? {} : { price: params.price }),
    ...(params.lotSize === undefined ? {} : { lotSize: params.lotSize }),
    ...(params.indicators1 === undefined ? {} : { indicators1: params.indicators1 }),
  };
}

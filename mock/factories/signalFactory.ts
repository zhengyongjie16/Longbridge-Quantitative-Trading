/**
 * 信号 Mock 工厂
 *
 * 功能：
 * - 按测试需求生成可定制字段的交易信号对象
 */
import type { Signal, SignalType } from '../../src/types/signal.js';

/**
 * 按测试需求构造可定制字段的交易信号，未传字段使用默认值（如 reason、seatVersion、triggerTime）。
 */
export function createSignal(params: {
  readonly symbol: string;
  readonly action: SignalType;
  readonly seatVersion?: number;
  readonly triggerTimeMs?: number;
  readonly price?: number;
  readonly lotSize?: number;
  readonly reason?: string;
  readonly indicators1?: Readonly<Record<string, number>>;
}): Signal {
  return {
    symbol: params.symbol,
    symbolName: params.symbol,
    action: params.action,
    reason: params.reason ?? 'mock-signal',
    seatVersion: params.seatVersion ?? 1,
    triggerTime: new Date(params.triggerTimeMs ?? Date.now()),
    ...(params.price === null || params.price === undefined ? {} : { price: params.price }),
    ...(params.lotSize === null || params.lotSize === undefined ? {} : { lotSize: params.lotSize }),
    ...(params.indicators1 === null || params.indicators1 === undefined
      ? {}
      : { indicators1: params.indicators1 }),
  };
}

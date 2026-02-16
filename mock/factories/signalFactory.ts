/**
 * @module mock/factories/signalFactory.ts
 * @description 信号 Mock 工厂模块，按测试需求生成可定制字段的交易信号对象。
 */
import type { Signal, SignalType } from '../../src/types/signal.js';

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
    ...(params.price == null ? {} : { price: params.price }),
    ...(params.lotSize == null ? {} : { lotSize: params.lotSize }),
    ...(params.indicators1 == null ? {} : { indicators1: params.indicators1 }),
  };
}

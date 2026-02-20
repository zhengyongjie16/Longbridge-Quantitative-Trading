/**
 * 自动换标模块：交易信号构造与数量计算
 *
 * 职责：
 * - 方向动作映射
 * - 名义金额换算下单数量
 * - 对象池构造信号
 */
import type { Signal } from '../../types/signal.js';
import type { BuildOrderSignalParams, OrderSignalBuilder, SignalBuilderDeps } from './types.js';

/**
 * 将方向映射到对应的买卖动作与牛熊方向（LONG→BUYCALL/SELLCALL，SHORT→BUYPUT/SELLPUT）。
 * @param direction - 'LONG' | 'SHORT'
 * @returns isBull、buyAction、sellAction
 */
export function resolveDirectionSymbols(direction: 'LONG' | 'SHORT'): {
  readonly isBull: boolean;
  readonly buyAction: 'BUYCALL' | 'BUYPUT';
  readonly sellAction: 'SELLCALL' | 'SELLPUT';
} {
  const isBull = direction === 'LONG';
  return {
    isBull,
    buyAction: isBull ? 'BUYCALL' : 'BUYPUT',
    sellAction: isBull ? 'SELLCALL' : 'SELLPUT',
  } as const;
}

/**
 * 根据名义金额计算买入数量，按 lotSize 向下取整；无法满足最小手数时返回 null。
 * @param notional - 名义金额
 * @param price - 价格
 * @param lotSize - 每手股数
 * @returns 手数（整数），不满足最小手数时 null
 */
export function calculateBuyQuantityByNotional(
  notional: number,
  price: number,
  lotSize: number,
): number | null {
  if (!Number.isFinite(notional) || notional <= 0) {
    return null;
  }
  if (!Number.isFinite(price) || price <= 0) {
    return null;
  }
  if (!Number.isFinite(lotSize) || lotSize <= 0) {
    return null;
  }
  let rawQuantity = Math.floor(notional / price);
  rawQuantity = Math.floor(rawQuantity / lotSize) * lotSize;
  return rawQuantity >= lotSize ? rawQuantity : null;
}

/**
 * 创建信号构造器，绑定对象池依赖，对外暴露 buildOrderSignal 方法。
 * @param deps - 依赖，包含 signalObjectPool
 * @returns 含 buildOrderSignal 的对象
 */
export function createSignalBuilder(deps: SignalBuilderDeps): {
  buildOrderSignal: OrderSignalBuilder;
} {
  const { signalObjectPool } = deps;

  /**
   * 使用对象池构造订单信号，避免频繁分配对象。
   */
  const buildOrderSignal: OrderSignalBuilder = (params: BuildOrderSignalParams): Signal => {
    const { action, symbol, quote, reason, orderTypeOverride, quantity, seatVersion } = params;
    const signal = signalObjectPool.acquire() as Signal;
    signal.symbol = symbol;
    signal.symbolName = quote?.name ?? symbol;
    signal.action = action;
    signal.reason = reason;
    signal.orderTypeOverride = orderTypeOverride ?? null;
    signal.price = quote?.price ?? null;
    signal.lotSize = quote?.lotSize ?? null;
    signal.quantity = quantity ?? null;
    signal.triggerTime = new Date();
    signal.seatVersion = seatVersion;
    return signal;
  };

  return {
    buildOrderSignal,
  };
}

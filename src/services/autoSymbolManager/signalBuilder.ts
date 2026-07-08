/**
 * 自动换标模块：交易信号构造与数量计算
 *
 * 职责：
 * - 方向动作映射
 * - 名义金额换算下单数量
 * - 构造订单信号
 */
import { calculateLotQuantityByNotional, decimalToNumberValue } from '../../utils/numeric/index.js';
import type { BuildOrderSignalParams, OrderSignal, OrderSignalBuilder } from './types.js';

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
  const quantity = calculateLotQuantityByNotional({
    notional,
    price,
    lotSize,
  });
  if (!quantity) {
    return null;
  }

  return decimalToNumberValue(quantity);
}

/**
 * 构造订单信号。
 */
const buildOrderSignal: OrderSignalBuilder = (params: BuildOrderSignalParams): OrderSignal => {
  const { action, symbol, quote, reason, orderTypeOverride, quantity, seatVersion } = params;

  return {
    symbol,
    symbolName: quote?.name ?? symbol,
    action,
    reason,
    orderTypeOverride: orderTypeOverride ?? null,
    price: quote?.price ?? null,
    lotSize: quote?.lotSize ?? null,
    quantity: quantity ?? null,
    triggerTime: new Date(),
    seatVersion,
  };
};

/**
 * 创建信号构造器，对外暴露 buildOrderSignal 方法。
 * @returns 含 buildOrderSignal 的对象
 */
export function createSignalBuilder(): {
  buildOrderSignal: OrderSignalBuilder;
} {
  return {
    buildOrderSignal,
  };
}

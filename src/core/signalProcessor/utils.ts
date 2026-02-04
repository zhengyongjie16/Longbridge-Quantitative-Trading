/**
 * 信号处理模块工具函数
 *
 * 提供卖出信号处理相关的工具函数：
 * - 持仓/行情数据校验
 * - 卖出原因文本构建
 * - 智能平仓数量计算
 * - 全仓平仓数量计算
 * - 标的名称解析
 */
import type { OrderRecorder, Quote, Position } from '../../types/index.js';
import type { SellContextValidationResult, SellQuantityResult } from './types.js';

/**
 * 验证持仓和行情数据是否满足卖出条件
 * 条件：持仓存在且可用数量 > 0，行情存在且价格 > 0
 */
function isValidPositionAndQuote(
  position: Position | null,
  quote: Quote | null,
): position is Position & { availableQuantity: number } {
  return (
    position !== null &&
    Number.isFinite(position.availableQuantity) &&
    position.availableQuantity !== null &&
    position.availableQuantity > 0 &&
    quote !== null &&
    Number.isFinite(quote.price) &&
    quote.price !== null &&
    quote.price > 0
  );
}

/**
 * 构建卖出原因文本
 * 将原始原因与详细说明用中文逗号拼接
 */
export function buildSellReason(originalReason: string, detail: string): string {
  const trimmedReason = originalReason.trim();
  if (!trimmedReason) {
    return detail;
  }
  return `${trimmedReason}，${detail}`;
}

/**
 * 校验卖出上下文数据有效性
 * 返回联合类型：校验通过则包含可用数量和当前价格，否则包含失败原因
 */
export function validateSellContext(
  position: Position | null,
  quote: Quote | null,
): SellContextValidationResult {
  if (!isValidPositionAndQuote(position, quote) || !quote) {
    return { valid: false, reason: '持仓或行情数据无效' };
  }

  return {
    valid: true,
    availableQuantity: position.availableQuantity,
    currentPrice: quote.price,
  };
}

/**
 * 智能平仓：计算盈利订单的卖出数量
 * 仅卖出买入价低于当前价格的订单，实现盈利部分平仓
 * 若无盈利订单或订单记录器不可用，返回 shouldHold=true
 */
export function resolveSellQuantityBySmartClose({
  orderRecorder,
  currentPrice,
  availableQuantity,
  direction,
  symbol,
}: {
  orderRecorder: OrderRecorder | null;
  currentPrice: number;
  availableQuantity: number;
  direction: 'LONG' | 'SHORT';
  symbol: string;
}): SellQuantityResult {
  if (!orderRecorder) {
    return {
      quantity: null,
      shouldHold: true,
      reason: '智能平仓：订单记录不可用，保持持仓',
    };
  }

  const buyOrdersBelowPrice = orderRecorder.getBuyOrdersBelowPrice(
    currentPrice,
    direction,
    symbol,
  );

  if (!buyOrdersBelowPrice || buyOrdersBelowPrice.length === 0) {
    return {
      quantity: null,
      shouldHold: true,
      reason: '智能平仓：无盈利订单，保持持仓',
    };
  }

  const totalQuantity = Math.min(
    orderRecorder.calculateTotalQuantity(buyOrdersBelowPrice),
    availableQuantity,
  );

  if (!Number.isFinite(totalQuantity) || totalQuantity <= 0) {
    return {
      quantity: null,
      shouldHold: true,
      reason: '智能平仓：无盈利订单，保持持仓',
    };
  }

  return {
    quantity: totalQuantity,
    shouldHold: false,
    reason: `智能平仓：当前价=${currentPrice.toFixed(3)}，卖出盈利订单数量=${totalQuantity}`,
  };
}

/**
 * 全仓平仓：返回全部可用数量
 * 智能平仓关闭时使用，直接清空所有持仓
 */
export function resolveSellQuantityByFullClose({
  availableQuantity,
  directionName,
}: {
  availableQuantity: number;
  directionName: string;
}): SellQuantityResult {
  return {
    quantity: availableQuantity,
    shouldHold: false,
    reason: `智能平仓已关闭，直接清空所有${directionName}持仓`,
  };
}

/**
 * 根据标的代码获取对应的中文名称
 * 匹配做多/做空标的代码，返回对应名称，未匹配则返回原始代码
 */
export function getSymbolName(
  signalSymbol: string,
  longSymbol: string | null,
  shortSymbol: string | null,
  longSymbolName: string | null,
  shortSymbolName: string | null,
): string | null {
  if (longSymbol && signalSymbol === longSymbol) {
    return longSymbolName;
  } else if (shortSymbol && signalSymbol === shortSymbol) {
    return shortSymbolName;
  }
  return signalSymbol;
}

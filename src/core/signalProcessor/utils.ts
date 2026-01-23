/**
 * 信号处理模块独享的工具函数
 */

import { normalizeHKSymbol } from '../../utils/helpers/index.js';
import type { OrderRecorder, Quote, Position } from '../../types/index.js';
import type { SellContextValidationResult, SellQuantityResult } from './types.js';

/**
 * 验证持仓和行情数据是否有效
 */
export function isValidPositionAndQuote(
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
 * 构建统一的卖出原因文本
 */
export function buildSellReason(originalReason: string, detail: string): string {
  const trimmedReason = originalReason.trim();
  if (!trimmedReason) {
    return detail;
  }
  return `${trimmedReason}，${detail}`;
}

/**
 * 校验卖出上下文所需的最小数据
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
 * 智能平仓开启时，根据盈利订单计算卖出数量
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
 * 智能平仓关闭时，直接全仓卖出
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
 * 根据信号标的获取对应的中文名称
 * @param signalSymbol 信号中的标的代码
 * @param longSymbol 做多标的代码
 * @param shortSymbol 做空标的代码
 * @param longSymbolName 做多标的中文名称
 * @param shortSymbolName 做空标的中文名称
 * @returns 标的中文名称，如果未找到则返回原始代码
 */
export function getSymbolName(
  signalSymbol: string,
  longSymbol: string | null,
  shortSymbol: string | null,
  longSymbolName: string | null,
  shortSymbolName: string | null,
): string | null {
  const normalizedSigSymbol = normalizeHKSymbol(signalSymbol);
  const normalizedLongSymbol = longSymbol ? normalizeHKSymbol(longSymbol) : null;
  const normalizedShortSymbol = shortSymbol ? normalizeHKSymbol(shortSymbol) : null;

  if (normalizedSigSymbol === normalizedLongSymbol) {
    return longSymbolName;
  } else if (normalizedSigSymbol === normalizedShortSymbol) {
    return shortSymbolName;
  }
  return signalSymbol;
}

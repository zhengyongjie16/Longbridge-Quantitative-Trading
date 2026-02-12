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
import type { SellContextValidationResult } from './types.js';

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
 * 智能平仓：计算盈利订单的卖出数量（防重版本）
 *
 * 算法：
 * 1. 从订单存储获取盈利订单（买入价 < 当前价）
 * 2. 排除已被待成交卖出的订单
 * 3. 返回可卖出的订单列表和数量
 *
 * @returns 包含可卖出数量、是否持有、以及关联订单ID列表的结果
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
}): {
  quantity: number | null;
  shouldHold: boolean;
  reason: string;
  relatedBuyOrderIds: readonly string[];
} {
  if (!orderRecorder) {
    return {
      quantity: null,
      shouldHold: true,
      reason: '智能平仓：订单记录不可用，保持持仓',
      relatedBuyOrderIds: [],
    };
  }

  const result = orderRecorder.getProfitableSellOrders(
    symbol,
    direction,
    currentPrice,
    availableQuantity,
  );

  if (result.orders.length === 0 || result.totalQuantity <= 0) {
    return {
      quantity: null,
      shouldHold: true,
      reason: '智能平仓：无盈利订单或已被占用',
      relatedBuyOrderIds: [],
    };
  }

  // 提取关联的订单ID列表
  const relatedBuyOrderIds = result.orders.map((order) => order.orderId);

  return {
    quantity: result.totalQuantity,
    shouldHold: false,
    reason: `智能平仓：当前价=${currentPrice.toFixed(3)}，可卖出=${result.totalQuantity}股，关联订单=${relatedBuyOrderIds.length}个`,
    relatedBuyOrderIds,
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
}): {
  quantity: number;
  shouldHold: boolean;
  reason: string;
  relatedBuyOrderIds: readonly string[];
} {
  return {
    quantity: availableQuantity,
    shouldHold: false,
    reason: `智能平仓已关闭，直接清空所有${directionName}持仓`,
    relatedBuyOrderIds: [],
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

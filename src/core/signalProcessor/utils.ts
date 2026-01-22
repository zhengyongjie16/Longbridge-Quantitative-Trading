/**
 * 信号处理模块独享的工具函数
 */

import { normalizeHKSymbol } from '../../utils/helpers/index.js';
import type { Quote, Position } from '../../types/index.js';

/**
 * 验证持仓和行情数据是否有效
 */
export function isValidPositionAndQuote(
  position: Position | null,
  quote: Quote | null,
): position is Position & { costPrice: number; availableQuantity: number } {
  return (
    position !== null &&
    Number.isFinite(position.costPrice) &&
    position.costPrice !== null &&
    position.costPrice > 0 &&
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

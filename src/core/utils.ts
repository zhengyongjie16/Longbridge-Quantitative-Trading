import type { Quote } from '../types/quote.js';

/**
 * 检查值是否已定义（不是 null 或 undefined）。默认行为：无。
 *
 * @param value 待检查的值
 * @returns 值非 null 且非 undefined 时返回 true，否则返回 false
 */
export function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

/**
 * 获取做多标的方向名称。默认行为：无参数，固定返回「做多标的」。
 *
 * @returns 做多标的方向名称字符串
 */
export function getLongDirectionName(): string {
  return '做多标的';
}

/**
 * 获取做空标的方向名称。默认行为：无参数，固定返回「做空标的」。
 *
 * @returns 做空标的方向名称字符串
 */
export function getShortDirectionName(): string {
  return '做空标的';
}

/**
 * 从行情对象生成标的显示字符串。默认行为：quote 存在时返回「中文名称(代码)」，否则返回 symbol。
 *
 * @param quote 行情对象（可选）
 * @param symbol 标的代码
 * @returns 格式化后的标的显示字符串
 */
export function formatSymbolDisplayFromQuote(
  quote: Quote | null | undefined,
  symbol: string,
): string {
  if (!quote) {
    return symbol;
  }

  const nameText = quote.name ?? '-';
  return `${nameText}(${symbol})`;
}

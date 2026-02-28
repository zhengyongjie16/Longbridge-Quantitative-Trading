import type { SignalType } from '../../types/signal.js';

/**
 * 格式化标的显示为「中文名称(代码)」。
 * 默认行为：symbol 为空返回空串；symbolName 为空时仅返回代码。
 *
 * @param symbol 标的代码
 * @param symbolName 标的中文名称，默认 null
 * @returns 格式化后的显示字符串
 */
export function formatSymbolDisplay(
  symbol: string | null | undefined,
  symbolName: string | null = null,
): string {
  if (!symbol) {
    return '';
  }
  if (symbolName) {
    return `${symbolName}(${symbol})`;
  }
  return symbol;
}

/**
 * 判断是否为卖出操作。
 *
 * @param action 信号类型
 * @returns 为 SELLCALL 或 SELLPUT 时返回 true
 */
export function isSellAction(action: SignalType): boolean {
  return action === 'SELLCALL' || action === 'SELLPUT';
}

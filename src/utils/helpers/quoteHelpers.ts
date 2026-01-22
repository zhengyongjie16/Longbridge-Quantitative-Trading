/**
 * 行情数据辅助函数
 */

import { normalizeHKSymbol } from './index.js';

/**
 * 收集所有需要获取行情的标的代码
 * 用于在主循环中一次性批量获取所有监控标的的行情
 *
 * @param monitorConfigs 监控配置数组
 * @returns 所有需要获取行情的标的代码集合（已规范化）
 */
export function collectAllQuoteSymbols(
  monitorConfigs: ReadonlyArray<{
    readonly monitorSymbol: string;
    readonly longSymbol: string;
    readonly shortSymbol: string;
  }>,
): Set<string> {
  const symbols = new Set<string>();

  for (const config of monitorConfigs) {
    symbols.add(normalizeHKSymbol(config.monitorSymbol));
    symbols.add(normalizeHKSymbol(config.longSymbol));
    symbols.add(normalizeHKSymbol(config.shortSymbol));
  }

  return symbols;
}

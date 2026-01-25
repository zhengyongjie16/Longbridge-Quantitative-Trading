/**
 * 行情数据辅助函数模块
 *
 * 功能：
 * - 收集监控配置中所有需要获取行情的标的代码
 * - 批量获取行情数据，减少 API 调用次数
 *
 * 核心函数：
 * - collectAllQuoteSymbols()：收集所有标的代码（已规范化）
 * - batchGetQuotes()：批量获取行情数据
 */

import { normalizeHKSymbol } from './index.js';
import type { MarketDataClient, Quote } from '../../types/index.js';

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

/**
 * 批量获取行情数据
 * 使用 marketDataClient.getQuotes 进行单次 API 调用批量获取，减少 API 调用次数
 *
 * @param marketDataClient 行情客户端
 * @param symbols 标的代码列表
 * @returns 标的代码到行情数据的映射（使用规范化后的标的代码作为 key）
 */
export async function batchGetQuotes(
  marketDataClient: MarketDataClient,
  symbols: Iterable<string>,
): Promise<Map<string, Quote | null>> {
  const symbolArray = Array.from(symbols);

  if (symbolArray.length === 0) {
    return new Map();
  }

  // 使用单次 API 调用批量获取所有行情
  return marketDataClient.getQuotes(symbolArray);
}

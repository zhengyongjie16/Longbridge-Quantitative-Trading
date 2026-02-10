/**
 * 行情数据辅助函数模块
 *
 * 功能：
 * - 收集监控配置中所有需要获取行情的标的代码
 * - 批量获取行情数据，减少 API 调用次数
 *
 * 核心函数：
 * - collectAllQuoteSymbols()：收集所有标的代码
 * - batchGetQuotes()：批量获取行情数据
 */
import type { MarketDataClient, Position, Quote, SymbolRegistry } from '../../types/index.js';

/**
 * 收集所有需要获取行情的标的代码
 * 用于在主循环中一次性批量获取所有监控标的的行情
 *
 * @param monitorConfigs 监控配置数组
 * @returns 所有需要获取行情的标的代码集合
 */
function collectAllQuoteSymbols(
  monitorConfigs: ReadonlyArray<{
    readonly monitorSymbol: string;
    readonly longSymbol: string;
    readonly shortSymbol: string;
  }>,
  symbolRegistry?: SymbolRegistry | null,
): Set<string> {
  const symbols = new Set<string>();

  for (const config of monitorConfigs) {
    symbols.add(config.monitorSymbol);
    if (!symbolRegistry) {
      continue;
    }
    const longSeat = symbolRegistry.getSeatState(config.monitorSymbol, 'LONG');
    const shortSeat = symbolRegistry.getSeatState(config.monitorSymbol, 'SHORT');
    if (longSeat.symbol) {
      symbols.add(longSeat.symbol);
    }
    if (shortSeat.symbol) {
      symbols.add(shortSeat.symbol);
    }
  }

  return symbols;
}

/**
 * 收集运行时需要获取行情的标的代码集合
 * 包括监控配置中的标的、当前持仓标的、订单持有标的
 *
 * @param monitorConfigs 监控配置数组
 * @param symbolRegistry 标的注册表
 * @param positions 当前持仓数组
 * @param orderHoldSymbols 订单持有标的集合
 * @returns 所有需要获取行情的标的代码集合
 */
export function collectRuntimeQuoteSymbols(
  monitorConfigs: ReadonlyArray<{
    readonly monitorSymbol: string;
    readonly longSymbol: string;
    readonly shortSymbol: string;
  }>,
  symbolRegistry: SymbolRegistry,
  positions: ReadonlyArray<Position>,
  orderHoldSymbols: ReadonlySet<string>,
): Set<string> {
  const symbols = collectAllQuoteSymbols(monitorConfigs, symbolRegistry);
  for (const position of positions) {
    if (position.symbol) {
      symbols.add(position.symbol);
    }
  }
  for (const symbol of orderHoldSymbols) {
    if (symbol) {
      symbols.add(symbol);
    }
  }
  return symbols;
}

/**
 * 计算行情标的集合的增量变化
 * @param prevSymbols 上一次订阅的标的集合
 * @param nextSymbols 最新需要订阅的标的集合
 * @returns 新增与移除的标的列表
 */
export function diffQuoteSymbols(
  prevSymbols: ReadonlySet<string>,
  nextSymbols: ReadonlySet<string>,
): { added: ReadonlyArray<string>; removed: ReadonlyArray<string> } {
  const added: string[] = [];
  const removed: string[] = [];

  for (const symbol of nextSymbols) {
    if (!prevSymbols.has(symbol)) {
      added.push(symbol);
    }
  }

  for (const symbol of prevSymbols) {
    if (!nextSymbols.has(symbol)) {
      removed.push(symbol);
    }
  }

  return { added, removed };
}

/**
 * 批量获取行情数据
 * 从行情客户端缓存批量读取（未订阅标的会抛错）
 *
 * @param marketDataClient 行情客户端
 * @param symbols 标的代码列表
 * @returns 标的代码到行情数据的映射（使用原始标的代码作为 key）
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

import type { Position } from '../../types/account.js';
import type { Quote } from '../../types/quote.js';
import type { SymbolRegistry } from '../../types/seat.js';
import type { MarketDataClient } from '../../types/services.js';

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
 * 收集运行时需要获取行情的标的代码集合（监控标的 + 席位占用标的 + 持仓标的 + 订单持有标的）。默认行为：合并去重后返回 Set。
 *
 * @param monitorConfigs 监控配置数组（monitorSymbol、longSymbol、shortSymbol）
 * @param symbolRegistry 标的注册表，用于解析席位当前占用标的
 * @param positions 当前持仓数组
 * @param orderHoldSymbols 订单持有标的集合
 * @returns 需要拉取行情的标的代码集合
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
 * 计算两个行情标的集合的增量（新增与移除）。默认行为：遍历比较后返回 added/removed 数组。
 *
 * @param prevSymbols 上一次的标的集合
 * @param nextSymbols 当前需要的标的集合
 * @returns 新增标的数组（added）与移除标的数组（removed）
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
 * 批量获取行情数据。默认行为：symbols 为空时返回空 Map，否则调用 marketDataClient.getQuotes。
 *
 * @param marketDataClient 行情客户端
 * @param symbols 标的代码可迭代对象
 * @returns 标的代码到行情数据的 Map（无行情时为 null）
 */
export async function batchGetQuotes(
  marketDataClient: MarketDataClient,
  symbols: Iterable<string>,
): Promise<Map<string, Quote | null>> {
  const symbolArray = Array.from(symbols);

  if (symbolArray.length === 0) {
    return new Map();
  }
  return marketDataClient.getQuotes(symbolArray);
}

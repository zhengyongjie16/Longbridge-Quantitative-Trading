/**
 * 行情数据辅助函数
 */

import type { MarketDataClient, Quote } from '../../types/index.js';

/**
 * 批量获取行情数据
 * @param marketDataClient 行情客户端
 * @param symbols 标的代码列表
 * @returns 标的代码到行情数据的映射
 */
export async function batchGetQuotes(
  marketDataClient: MarketDataClient,
  symbols: Iterable<string>,
): Promise<Map<string, Quote | null>> {
  const symbolArray = Array.from(symbols);

  const quotePromises = symbolArray.map((symbol) =>
    marketDataClient
      .getLatestQuote(symbol)
      .then((quote: Quote | null) => ({ symbol, quote }))
      .catch(() => ({ symbol, quote: null as Quote | null })),
  );

  const results = await Promise.all(quotePromises);
  return new Map(results.map(({ symbol, quote }: { symbol: string; quote: Quote | null }) => [symbol, quote]));
}

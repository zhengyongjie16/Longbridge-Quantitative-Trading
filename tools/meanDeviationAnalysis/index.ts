/**
 * 均值偏离分析工具。
 * 职责：读取标的与交易日数量，抓取最近 N 个交易日的分钟 K 线，计算每分钟相对当时累计 VWAP 的偏离幅度并输出每日统计表格。
 * 流程：解析参数 -> 初始化 Longbridge SDK -> 拉取最近 N 个交易日 -> 逐日抓取分钟 K 线 -> 计算偏离指标 -> 输出表格。
 */
import dotenv from 'dotenv';
import { AdjustType, Period, QuoteContext, TradeSessions } from 'longbridge';

import { createSdkConfigFromAuth } from '../../src/config/auth/index.js';
import type { DailyDeviationMetrics, MeanDeviationQuoteContext } from './types.js';
import {
  computeDailyDeviationMetrics,
  formatTradeDate,
  normalizeMinuteCandle,
  parseAnalysisOptions,
  renderMetricsTable,
  toNaiveDate,
} from './utils.js';

dotenv.config({ path: '.env.local' });

/**
 * 拉取最近 N 个交易日并计算每个交易日的均值偏离统计。
 *
 * @param quoteContext Longbridge 行情上下文
 * @param symbol 标的代码
 * @param days 最近交易日数量
 * @returns 每个交易日的偏离统计结果
 */
async function loadDeviationMetrics(params: {
  readonly quoteContext: MeanDeviationQuoteContext;
  readonly symbol: string;
  readonly days: number;
}): Promise<ReadonlyArray<DailyDeviationMetrics>> {
  const dailyCandles = await params.quoteContext.candlesticks(
    params.symbol,
    Period.Day,
    params.days,
    AdjustType.NoAdjust,
    TradeSessions.Intraday,
  );
  if (dailyCandles.length === 0) {
    throw new Error(`标的 ${params.symbol} 未获得最近交易日数据`);
  }

  const tradeDates = dailyCandles.map((candle) => formatTradeDate(candle.timestamp));
  const metrics: DailyDeviationMetrics[] = [];

  for (const tradeDate of tradeDates) {
    const naiveDate = toNaiveDate(tradeDate);
    const minuteCandles = await params.quoteContext.historyCandlesticksByDate(
      params.symbol,
      Period.Min_1,
      AdjustType.NoAdjust,
      naiveDate,
      naiveDate,
      TradeSessions.Intraday,
    );
    const normalizedCandles = minuteCandles.map(normalizeMinuteCandle);
    metrics.push(
      computeDailyDeviationMetrics({
        tradeDate,
        minuteCandles: normalizedCandles,
      }),
    );
  }

  return metrics;
}

async function main(): Promise<void> {
  const options = parseAnalysisOptions(process.argv);

  console.log(`开始分析标的: ${options.symbol}`);
  console.log(`最近交易日数量: ${options.days}`);

  const config = await createSdkConfigFromAuth({
    env: process.env,
    onOpenUrl: (url: string) => {
      console.log(`请在浏览器中完成 Longbridge OAuth 授权：${url}`);
    },
  });
  const quoteContext: MeanDeviationQuoteContext = QuoteContext.new(config);
  const metrics = await loadDeviationMetrics({
    quoteContext,
    symbol: options.symbol,
    days: options.days,
  });
  console.log(renderMetricsTable({ symbol: options.symbol, metrics }));
}

try {
  await main();
} catch (error: unknown) {
  console.error('程序执行失败:', error);
  process.exit(1);
}

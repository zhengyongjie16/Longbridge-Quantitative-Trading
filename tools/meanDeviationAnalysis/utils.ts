import { NaiveDate } from 'longbridge';

import { formatFiniteNumber } from '../utils.js';
import { decimalToNumber } from '../../src/utils/helpers/index.js';
import { toHongKongTimeLog } from '../../src/utils/time/index.js';
import type { DecimalLike } from '../../src/utils/helpers/types.js';
import type {
  AnalysisOptions,
  ComputeDailyDeviationMetricsParams,
  DailyDeviationMetrics,
  DeviationExtremeSnapshot,
  MinuteDeviationCandle,
  RenderMetricsTableParams,
} from './types.js';

/**
 * 解析命令行参数，要求显式传入标的代码，可选传入交易日数量。
 *
 * @param argv 原始命令行参数
 * @returns 规范化后的分析参数
 */
export function parseAnalysisOptions(argv: ReadonlyArray<string>): AnalysisOptions {
  let symbol: string | null = null;
  let days = 20;

  for (let index = 2; index < argv.length; index += 1) {
    const currentArg = argv[index];
    if (currentArg === '--symbol') {
      symbol = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (currentArg === '--days') {
      const daysText = argv[index + 1] ?? '';
      const parsedDays = Number(daysText);
      if (!Number.isInteger(parsedDays) || parsedDays <= 0) {
        throw new Error(`--days 必须为正整数，当前值: ${daysText || '(empty)'}`);
      }

      days = parsedDays;
      index += 1;
      continue;
    }

    throw new Error(`不支持的参数: ${currentArg}`);
  }

  if (symbol === null || symbol.length === 0) {
    throw new Error('必须通过 --symbol 指定标的，例如 --symbol 981.HK');
  }

  return {
    symbol,
    days,
  };
}

/**
 * 将 Longbridge 时间戳转换为港股交易日字符串。
 *
 * @param timestamp SDK 返回时间戳
 * @returns 港股交易日文本 YYYY-MM-DD
 */
export function formatTradeDate(timestamp: Date): string {
  return toHongKongTimeLog(timestamp).slice(0, 10);
}

/**
 * 将交易日字符串转换为 NaiveDate，用于历史分钟 K 线查询。
 *
 * @param tradeDate 交易日字符串 YYYY-MM-DD
 * @returns Longbridge NaiveDate 实例
 */
export function toNaiveDate(tradeDate: string): NaiveDate {
  const [yearText, monthText, dayText] = tradeDate.split('-');
  return new NaiveDate(Number(yearText), Number(monthText), Number(dayText));
}

/**
 * 标准化分钟 K 线数值字段。
 *
 * @param candle 外部分钟 K 线记录
 * @returns 内部计算所需的最小字段
 */
export function normalizeMinuteCandle(candle: {
  readonly close: DecimalLike;
  readonly volume: number;
  readonly timestamp: Date;
}): MinuteDeviationCandle {
  return {
    close: decimalToNumber(candle.close),
    volume: candle.volume,
    timestamp: candle.timestamp,
  };
}

/**
 * 将分钟 K 线时间格式化为香港时间 HH:mm。
 *
 * @param timestamp 分钟 K 线时间
 * @returns 香港时间 HH:mm
 */
function formatKlineTime(timestamp: Date): string {
  return toHongKongTimeLog(timestamp).slice(11, 16);
}

/**
 * 构造偏移极值快照。
 *
 * @param candle 当前分钟 K 线
 * @param averagePrice 当前分钟对应的日内累计 VWAP
 * @param deviationPct 当前分钟相对累计 VWAP 的偏移率
 * @returns 包含价格、均价、偏移率与香港 K 线时间的快照
 */
function buildDeviationExtremeSnapshot(
  candle: MinuteDeviationCandle,
  averagePrice: number,
  deviationPct: number,
): DeviationExtremeSnapshot {
  return {
    deviationPct,
    currentPrice: candle.close,
    averagePrice,
    klineTime: formatKlineTime(candle.timestamp),
  };
}

/**
 * 校验分钟 K 线必须按时间升序排列，避免累计 VWAP 使用错误时间前缀。
 *
 * @param tradeDate 交易日字符串
 * @param minuteCandles 分钟 K 线样本
 * @returns 无返回值，顺序错误时抛错
 */
function assertMinuteCandlesSortedByTime(
  tradeDate: string,
  minuteCandles: ReadonlyArray<MinuteDeviationCandle>,
): void {
  for (let index = 1; index < minuteCandles.length; index += 1) {
    const previousCandle = minuteCandles[index - 1];
    const currentCandle = minuteCandles[index];
    if (previousCandle === undefined || currentCandle === undefined) {
      throw new Error(`交易日 ${tradeDate} 分钟 K 线时间必须按升序排列`);
    }

    if (currentCandle.timestamp.getTime() < previousCandle.timestamp.getTime()) {
      throw new Error(`交易日 ${tradeDate} 分钟 K 线时间必须按升序排列`);
    }
  }
}

/**
 * 计算某个交易日内每分钟相对当时累计 VWAP 的最大上偏离、最大下偏离和平均绝对偏离。
 *
 * @param params 交易日与分钟级样本
 * @returns 单日偏离统计结果
 */
export function computeDailyDeviationMetrics(
  params: ComputeDailyDeviationMetricsParams,
): DailyDeviationMetrics {
  if (params.minuteCandles.length === 0) {
    throw new Error(`交易日 ${params.tradeDate} 未获得有效分钟数据`);
  }

  if (params.minuteCandles.some((candle) => !Number.isFinite(candle.close) || candle.close <= 0)) {
    throw new Error(`交易日 ${params.tradeDate} 包含无效分钟收盘价`);
  }

  if (
    params.minuteCandles.some((candle) => !Number.isFinite(candle.volume) || candle.volume <= 0)
  ) {
    throw new Error(`交易日 ${params.tradeDate} 包含无效分钟成交量`);
  }

  if (
    params.minuteCandles.some(
      (candle) =>
        !(candle.timestamp instanceof Date) || !Number.isFinite(candle.timestamp.getTime()),
    )
  ) {
    throw new Error(`交易日 ${params.tradeDate} 包含无效分钟 K 线时间`);
  }

  assertMinuteCandlesSortedByTime(params.tradeDate, params.minuteCandles);

  let cumulativePriceVolume = 0;
  let cumulativeVolume = 0;
  let maxUpDeviation: DeviationExtremeSnapshot | null = null;
  let maxDownDeviation: DeviationExtremeSnapshot | null = null;
  let absoluteDeviationSum = 0;

  for (const candle of params.minuteCandles) {
    cumulativePriceVolume += candle.close * candle.volume;
    cumulativeVolume += candle.volume;
    const averagePrice = cumulativePriceVolume / cumulativeVolume;
    const deviationPct = ((candle.close - averagePrice) / averagePrice) * 100;
    if (maxUpDeviation === null || deviationPct > maxUpDeviation.deviationPct) {
      maxUpDeviation = buildDeviationExtremeSnapshot(candle, averagePrice, deviationPct);
    }

    if (maxDownDeviation === null || deviationPct < maxDownDeviation.deviationPct) {
      maxDownDeviation = buildDeviationExtremeSnapshot(candle, averagePrice, deviationPct);
    }

    absoluteDeviationSum += Math.abs(deviationPct);
  }

  if (maxUpDeviation === null || maxDownDeviation === null) {
    throw new Error(`交易日 ${params.tradeDate} 无法生成偏移极值`);
  }

  return {
    tradeDate: params.tradeDate,
    maxUpDeviation,
    maxDownDeviation,
    averageDeviationPct: absoluteDeviationSum / params.minuteCandles.length,
  };
}

/**
 * 将单日偏离统计渲染为终端表格。
 *
 * @param params 标的与每日统计结果
 * @returns 可直接输出到终端的表格文本
 */
export function renderMetricsTable(params: RenderMetricsTableParams): string {
  const lines = [
    `标的: ${params.symbol}`,
    '',
    '| 交易日 | 向上最大偏离 | 向上当前价 | 向上均价 | 向上时间 | 向下最大偏离 | 向下当前价 | 向下均价 | 向下时间 | 平均偏离幅度 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];

  for (const metric of params.metrics) {
    lines.push(
      `| ${metric.tradeDate} | ${formatFiniteNumber(metric.maxUpDeviation.deviationPct, 4)}% | ${formatFiniteNumber(metric.maxUpDeviation.currentPrice, 4)} | ${formatFiniteNumber(metric.maxUpDeviation.averagePrice, 4)} | ${metric.maxUpDeviation.klineTime} | ${formatFiniteNumber(metric.maxDownDeviation.deviationPct, 4)}% | ${formatFiniteNumber(metric.maxDownDeviation.currentPrice, 4)} | ${formatFiniteNumber(metric.maxDownDeviation.averagePrice, 4)} | ${metric.maxDownDeviation.klineTime} | ${formatFiniteNumber(metric.averageDeviationPct, 4)}% |`,
    );
  }

  return lines.join('\n');
}

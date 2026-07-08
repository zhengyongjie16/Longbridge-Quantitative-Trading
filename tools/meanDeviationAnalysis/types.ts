import type { AdjustType, NaiveDate, Period, TradeSessions } from 'longbridge';

import type { DecimalLike } from '../../src/utils/helpers/types.js';

/**
 * 命令行分析参数。
 * 用途：约束工具入口层对用户输入的解析结果。
 * 使用范围：仅 meanDeviationAnalysis 工具内部使用。
 */
export type AnalysisOptions = {
  readonly symbol: string;
  readonly days: number;
};

/**
 * 分钟级分析输入。
 * 用途：抽象均值偏离统计所需的最小分钟 K 线字段。
 * 数据来源：Longbridge 分钟级 K 线返回值。
 * 使用范围：仅 meanDeviationAnalysis 工具内部使用。
 */
export type MinuteDeviationCandle = {
  readonly close: number;
  readonly volume: number;
  readonly timestamp: Date;
};

/**
 * 单个偏移极值快照。
 * 用途：保存最大向上或最大向下偏移发生时的完整价格与时间事实。
 * 数据来源：对应分钟收盘价、当时的日内累计 VWAP 和分钟 K 线时间。
 * 使用范围：DailyDeviationMetrics 与终端表格渲染。
 */
export type DeviationExtremeSnapshot = {
  readonly deviationPct: number;
  readonly currentPrice: number;
  readonly averagePrice: number;
  readonly klineTime: string;
};

/**
 * 单日均值偏离统计结果。
 * 用途：承载终端表格输出所需的每日偏离指标和双向极值快照。
 * 数据来源：由每分钟收盘价相对该时点当日累计 VWAP 计算得出。
 * 使用范围：仅 meanDeviationAnalysis 工具内部使用。
 */
export type DailyDeviationMetrics = {
  readonly tradeDate: string;
  readonly maxUpDeviation: DeviationExtremeSnapshot;
  readonly maxDownDeviation: DeviationExtremeSnapshot;
  readonly averageDeviationPct: number;
};

/**
 * 单日统计计算参数。
 * 用途：向纯函数传入交易日与分钟级 K 线样本。
 * 数据来源：入口层抓取后的标准化数据。
 * 使用范围：仅 computeDailyDeviationMetrics 使用。
 */
export type ComputeDailyDeviationMetricsParams = {
  readonly tradeDate: string;
  readonly minuteCandles: ReadonlyArray<MinuteDeviationCandle>;
};

/**
 * 终端表格渲染参数。
 * 用途：约束 renderMetricsTable 的输入边界。
 * 使用范围：仅 meanDeviationAnalysis 工具内部使用。
 */
export type RenderMetricsTableParams = {
  readonly symbol: string;
  readonly metrics: ReadonlyArray<DailyDeviationMetrics>;
};

/**
 * Longbridge 行情边界最小契约。
 * 用途：隔离入口层与 SDK 的直接依赖，便于测试替换。
 * 使用范围：仅 meanDeviationAnalysis 入口层使用。
 */
export interface MeanDeviationQuoteContext {
  candlesticks: (
    symbol: string,
    period: Period,
    count: number,
    adjustType: AdjustType,
    tradeSessions: TradeSessions,
  ) => Promise<ReadonlyArray<{ readonly timestamp: Date }>>;
  historyCandlesticksByDate: (
    symbol: string,
    period: Period,
    adjustType: AdjustType,
    start: NaiveDate,
    end: NaiveDate,
    tradeSessions: TradeSessions,
  ) => Promise<
    ReadonlyArray<{
      readonly close: DecimalLike;
      readonly volume: number;
      readonly timestamp: Date;
    }>
  >;
}

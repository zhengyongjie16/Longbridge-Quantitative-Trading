import type { CandleData } from '../../../types/data.js';
import type { IndicatorUsageProfile } from '../../../types/indicatorProfile.js';

/**
 * 环形缓冲区状态。
 * 类型用途：在 MFI 计算中维护固定窗口的正向/负向资金流累加，支持 O(1) 滑动窗口更新。
 * 使用范围：仅 indicators 子模块 mfi.ts 内部使用。
 * 数据来源：由当前模块的入参、返回值或运行时派生数据提供（如适用）。
 */
export type BufferNewPush = {
  readonly size: number;
  index: number;
  pushes: number;
  sum: number;
  readonly vals: number[];
};

/**
 * EMA 流式计算状态。
 * 类型用途：记录单条 EMA 流的 seed 阶段累加值与当前 EMA 值，供 initEmaStreamState / feedEmaStreamState 共用。
 * 数据来源：由 initEmaStreamState 初始化，由 feedEmaStreamState 逐值更新。
 * 使用范围：仅 indicators 子模块内部（EMA、MACD、RSI 共用）。
 */
export type EmaStreamState = {
  readonly period: number;
  readonly per: number;
  seedCount: number;
  seedSum: number;
  emaValue: number | null;
};

/**
 * RSI 流式计算状态。
 * 类型用途：记录 RSI 计算过程中的 seed 阶段累加值、平滑上涨/下跌均值及最新原始 RSI 值。
 * 数据来源：由 initRsiStreamState 初始化，由 updateRsiStreamState 逐根 K 线更新。
 * 使用范围：仅 indicators 子模块 rsi.ts 内部使用。
 */
export type RsiStreamState = {
  readonly period: number;
  readonly per: number;
  previousClose: number | null;
  seedDiffCount: number;
  seedUpSum: number;
  seedDownSum: number;
  smoothUp: number;
  smoothDown: number;
  lastRawValue: number | null;
};

/**
 * PSY 流式计算状态。
 * 类型用途：记录 PSY 计算过程中的环形上涨标志窗口、有效收盘价计数及当前窗口内上涨次数。
 * 数据来源：由 initPsyStreamState 初始化，由 updatePsyStreamState 逐根 K 线更新。
 * 使用范围：仅 indicators 子模块 psy.ts 内部使用。
 */
export type PsyStreamState = {
  readonly period: number;
  readonly upFlags: number[];
  previousClose: number | null;
  validCloseCount: number;
  windowCount: number;
  windowIndex: number;
  upCount: number;
};

/**
 * MACD 流式状态。
 * 类型用途：维护 fast/slow/signal 三条 EMA 流与最近 DIF/DEA/Histogram 值。
 * 数据来源：bootstrap 与运行期增量推进。
 * 使用范围：仅 indicators/runtime 模块内部使用。
 */
export type MacdStreamState = {
  readonly fastPeriod: number;
  readonly slowPeriod: number;
  readonly signalPeriod: number;
  fastEmaState: EmaStreamState;
  slowEmaState: EmaStreamState;
  signalEmaState: EmaStreamState;
  validCloseCount: number;
  lastDif: number | null;
  lastSignal: number | null;
  lastHistogram: number | null;
};

/**
 * MFI 流式状态。
 * 类型用途：维护典型价比较、正负资金流环形窗口与最后一个原始值。
 * 数据来源：bootstrap 与运行期增量推进。
 * 使用范围：仅 indicators/runtime 模块内部使用。
 */
export type MfiStreamState = {
  readonly period: number;
  previousTypicalPrice: number | null;
  validOhlcvCount: number;
  upBuffer: BufferNewPush;
  downBuffer: BufferNewPush;
  lastRawValue: number | null;
};

/**
 * ADX 流式状态。
 * 类型用途：维护 Wilder 平滑所需的 TR/+DM/-DM 与 DX/ADX 递推状态。
 * 数据来源：bootstrap 与运行期增量推进。
 * 使用范围：仅 indicators/runtime 模块内部使用。
 */
export type AdxStreamState = {
  readonly period: number;
  prevHigh: number | null;
  prevLow: number | null;
  prevClose: number | null;
  trDmCount: number;
  smoothTr: number;
  smoothPlusDm: number;
  smoothMinusDm: number;
  initialDxSum: number;
  dxCount: number;
  adx: number | null;
};

/**
 * KDJ 流式状态。
 * 类型用途：维护 RSV 窗口单调队列与 K/D 平滑状态，支持逐根增量推进。
 * 数据来源：bootstrap 与运行期增量推进。
 * 使用范围：仅 indicators/runtime 模块内部使用。
 */
export type KdjStreamState = {
  readonly period: number;
  readonly emaPeriod: number;
  index: number;
  maxIndexDeque: number[];
  maxValueDeque: number[];
  minIndexDeque: number[];
  minValueDeque: number[];
  emaKState: EmaStreamState;
  emaDState: EmaStreamState;
  hasKdjValue: boolean;
  lastK: number;
  lastD: number;
};

/**
 * 指标 committed 状态。
 * 类型用途：保存仅由“已确认收线 bar”推进得到的稳定状态。
 * 数据来源：bootstrap 初始化与 confirmed/shift commit 更新。
 * 使用范围：仅 indicators/runtime 模块内部使用。
 */
export type IndicatorCommittedState = {
  lastValidClose: number | null;
  previousValidClose: number | null;
  emaStates: Record<number, EmaStreamState>;
  rsiStates: Record<number, RsiStreamState>;
  psyStates: Record<number, PsyStreamState>;
  mfiState: MfiStreamState | null;
  kdjState: KdjStreamState | null;
  macdState: MacdStreamState | null;
  adxState: AdxStreamState | null;
};

/**
 * 增量指标运行态字段。
 * 类型用途：描述 runtime 内部持有的真实状态字段，供 index.ts 组合 brand 后形成内部运行态类型。
 * 数据来源：bootstrap 与 updateRuntimeForCandlestickSnapshot。
 * 使用范围：仅 indicators/runtime 模块内部。
 */
export type IndicatorRuntimeStateFields = {
  readonly symbol: string;
  readonly profile: IndicatorUsageProfile;
  lastProcessedVersion: number;
  closedBarTimestamp: number | null;
  activeBarTimestamp: number | null;
  activeBarConfirmed: boolean | null;
  activeBar: CandleData | null;
  lastBarTimestamp: number | null;
  lastBarConfirmed: boolean | null;
  committed: IndicatorCommittedState;
};

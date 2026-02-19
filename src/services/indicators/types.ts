/**
 * EMA 流式计算接口。
 * 类型用途：对外暴露单条 EMA 流的逐值推送接口，每次调用返回当前 EMA 值（seed 阶段未满时返回 undefined）。
 * 数据来源：由 createEmaStream 创建并返回。
 * 使用范围：供 ema.ts 及依赖 EMA 的指标模块使用。
 */
export type EmaStream = {
  nextValue: (value: number) => number | undefined;
};

/**
 * 环形缓冲区状态。
 * 类型用途：在 MFI 计算中维护固定窗口的正向/负向资金流累加，支持 O(1) 滑动窗口更新。
 * 使用范围：仅 indicators 子模块 mfi.ts 内部使用。
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

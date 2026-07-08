/**
 * K 线数据值类型。
 * 类型用途：兼容 Longbridge SDK 的 Decimal 与原始数值，作为 CandleData 各 OHLCV 字段的类型。
 * 数据来源：Longbridge K 线 API 返回。
 * 使用范围：CandleData 字段内部复用，不作为跨模块公共类型导出。
 */
type CandleValue = number | string | { toString: () => string } | null | undefined;

/**
 * K 线数据。
 * 类型用途：表示单根 K 线的 OHLCV 数据，用于指标计算、策略输入等。
 * 数据来源：Longbridge K 线 API（如 candlesticks、实时 K 线）。
 * 使用范围：indicators、策略、indicatorCache 等；全项目可引用。
 */
export type CandleData = {
  /** K 线时间戳（毫秒） */
  readonly timestamp?: number;

  /** 最高价 */
  readonly high?: CandleValue;

  /** 最低价 */
  readonly low?: CandleValue;

  /** 收盘价 */
  readonly close?: CandleValue;

  /** 开盘价 */
  readonly open?: CandleValue;

  /** 成交量 */
  readonly volume?: CandleValue;
};

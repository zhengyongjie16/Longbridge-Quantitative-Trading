import type { KDJIndicator, MACDIndicator } from './quote.js';

/**
 * K 线数据值类型。
 * 类型用途：兼容 LongPort SDK 的 Decimal 与原始数值，作为 CandleData 各 OHLCV 字段的类型。
 * 数据来源：LongPort K 线 API 返回。
 * 使用范围：CandleData、指标计算等；全项目可引用。
 */
export type CandleValue = number | string | { toString: () => string } | null | undefined;

/**
 * K 线数据。
 * 类型用途：表示单根 K 线的 OHLCV 数据，用于指标计算、策略输入等。
 * 数据来源：LongPort K 线 API（如 candlesticks、实时 K 线）。
 * 使用范围：indicators、策略、indicatorCache 等；全项目可引用。
 */
export type CandleData = {
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

/**
 * 监控值。
 * 类型用途：市场监控用的技术指标集合（价格、EMA、RSI、KDJ、MACD 等），作为 MonitorState.monitorValues 类型；需可变以支持对象池（PoolableMonitorValues）。
 * 数据来源：由 K 线经指标计算得到（如 indicatorCache、marketMonitor）。
 * 使用范围：MonitorState、策略、主循环等；全项目可引用。
 */
export type MonitorValues = {
  /** 当前价格 */
  price: number | null;
  /** 涨跌幅 */
  changePercent: number | null;
  /** EMA 指数移动平均 */
  ema: Readonly<Record<number, number>> | null;
  /** RSI 相对强弱指标 */
  rsi: Readonly<Record<number, number>> | null;
  /** PSY 心理线指标 */
  psy: Readonly<Record<number, number>> | null;
  /** MFI 资金流量指标 */
  mfi: number | null;
  /** KDJ 随机指标 */
  kdj: KDJIndicator | null;
  /** MACD 指标 */
  macd: MACDIndicator | null;
};

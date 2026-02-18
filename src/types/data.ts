/**
 * 数据接口类型
 *
 * 功能：
 * - 定义 K 线数据和监控值相关的类型
 */
import type { KDJIndicator, MACDIndicator } from './quote.js';

/**
 * K线数据值类型
 * 兼容 LongPort SDK 的 Decimal 类型和原始数值
 */
export type CandleValue = number | string | { toString(): string } | null | undefined;

/**
 * K线数据
 * 表示单根 K 线的 OHLCV 数据
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
 * 监控值
 * 用于市场监控的技术指标集合
 *
 * @remarks 此类型需要可变以支持对象池的对象重用。对象池使用 PoolableMonitorValues 类型。
 * 嵌套的 Record 对象使用 Readonly 保证其内部不被修改。
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

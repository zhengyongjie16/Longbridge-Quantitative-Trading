/**
 * @module types/quote
 * @description 行情和指标类型定义
 *
 * 定义行情数据和技术指标相关的类型
 */

/**
 * 行情静态信息
 * 来自 LongPort API，包含标的的基本信息和牛熊证相关字段
 */
export type QuoteStaticInfo = {
  readonly nameHk?: string | null;
  readonly nameCn?: string | null;
  readonly nameEn?: string | null;
  readonly lotSize?: number | null;
  readonly lot_size?: number | null;
  readonly lot?: number | null;
  readonly callPrice?: number | null;
  readonly expiryDate?: string | null;
  readonly issuePrice?: number | null;
  readonly conversionRatio?: number | null;
  readonly warrantType?: 'BULL' | 'BEAR' | null;
  readonly underlyingSymbol?: string | null;
};

/**
 * 行情数据
 * 表示标的的实时行情信息
 */
export type Quote = {
  /** 标的代码 */
  readonly symbol: string;
  /** 标的名称 */
  readonly name: string | null;
  /** 当前价格 */
  readonly price: number;
  /** 前收盘价 */
  readonly prevClose: number;
  /** 行情时间戳 */
  readonly timestamp: number;
  /** 每手股数 */
  readonly lotSize?: number;
  /** 原始行情数据 */
  readonly raw?: unknown;
  /** 静态信息（如回收价、每手股数等） */
  readonly staticInfo?: QuoteStaticInfo | null;
};

/**
 * KDJ 随机指标
 * 用于判断超买超卖状态
 */
export type KDJIndicator = {
  /** K 值（快速随机值） */
  readonly k: number;
  /** D 值（K 的移动平均） */
  readonly d: number;
  /** J 值（3K-2D） */
  readonly j: number;
};

/**
 * MACD 指标
 * 用于判断趋势方向和强度
 */
export type MACDIndicator = {
  /** MACD 柱状图值 */
  readonly macd: number;
  /** DIF 快线（短期EMA - 长期EMA） */
  readonly dif: number;
  /** DEA 慢线（DIF 的移动平均） */
  readonly dea: number;
};

/**
 * 指标快照
 * 包含某一时刻的所有技术指标值
 */
export type IndicatorSnapshot = {
  /** 标的代码（可选，因为 Quote 已包含） */
  readonly symbol?: string;
  /** 当前价格 */
  readonly price: number;
  /** 涨跌幅（百分比） */
  readonly changePercent: number | null;
  /** EMA 指数移动平均（周期 -> 值） */
  readonly ema: Readonly<Record<number, number>> | null;
  /** RSI 相对强弱指标（周期 -> 值） */
  readonly rsi: Readonly<Record<number, number>> | null;
  /** PSY 心理线指标（周期 -> 值） */
  readonly psy: Readonly<Record<number, number>> | null;
  /** MFI 资金流量指标 */
  readonly mfi: number | null;
  /** KDJ 随机指标 */
  readonly kdj: KDJIndicator | null;
  /** MACD 指标 */
  readonly macd: MACDIndicator | null;
};

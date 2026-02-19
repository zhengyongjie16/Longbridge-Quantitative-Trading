/**
 * 行情静态信息
 * 来自 LongPort API，包含标的的基本信息和牛熊证相关字段
 */
export type QuoteStaticInfo = {
  readonly nameHk?: string | null;
  readonly nameCn?: string | null;
  readonly nameEn?: string | null;
  readonly lotSize?: number | null;
  readonly callPrice?: number | null;
  readonly expiryDate?: string | null;
  readonly issuePrice?: number | null;
  readonly conversionRatio?: number | null;
  readonly warrantType?: 'BULL' | 'BEAR' | null;
  readonly underlyingSymbol?: string | null;
};

/**
 * 行情数据。
 * 数据来源为 LongPort 行情推送或 getQuotes。
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
 * KDJ 随机指标。
 * 用于判断超买超卖；数据来源为指标计算（如 quote 层或 indicators 服务）。
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
 * MACD 指标。
 * 类型用途：表示 macd/dif/dea，用于趋势判断，作为 IndicatorSnapshot.macd 及策略输入的字段类型。
 * 数据来源：指标计算（indicators 服务或 quote 层）。
 * 使用范围：IndicatorSnapshot、策略、data.MonitorValues 等；全项目可引用。
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
 * 指标快照。
 * 用于信号判断与延迟验证。
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

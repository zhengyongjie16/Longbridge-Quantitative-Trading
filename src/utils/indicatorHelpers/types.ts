/**
 * KDJ 指标值结构。
 * 类型用途：描述 KDJ 三个分量的可选数值，用于指标状态表达与条件评估。
 * 数据来源：行情指标计算模块。
 * 使用范围：indicatorHelpers 模块及依赖其类型的策略模块。
 */
type IndicatorKdj = {
  readonly k?: number;
  readonly d?: number;
  readonly j?: number;
};

/**
 * MACD 指标值结构。
 * 类型用途：描述 MACD 的 macd/dif/dea 三个分量，用于指标状态表达与条件评估。
 * 数据来源：行情指标计算模块。
 * 使用范围：indicatorHelpers 模块及依赖其类型的策略模块。
 */
type IndicatorMacd = {
  readonly macd?: number;
  readonly dif?: number;
  readonly dea?: number;
};

/**
 * 指标状态接口。
 * 类型用途：描述单次主循环中各技术指标的当前计算值，用于信号条件评估。
 * 数据来源：由行情服务和指标计算模块填充后传入信号解析器。
 * 使用范围：indicatorHelpers 与策略评估相关模块。
 */
export type IndicatorState = {
  readonly ema?: Record<number, number> | null;
  readonly rsi?: Record<number, number> | null;
  readonly psy?: Record<number, number> | null;
  readonly mfi?: number | null;
  readonly kdj?: IndicatorKdj | null;
  readonly macd?: IndicatorMacd | null;
};

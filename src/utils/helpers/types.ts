/**
 * LongPort Decimal 兼容接口。
 * 类型用途：将 LongPort SDK 返回的 Decimal 统一转为 number（toNumber）。
 * 数据来源：LongPort SDK 返回值。
 * 使用范围：仅 helpers 模块内部使用。
 */
export type DecimalLike = {
  toNumber: () => number;
};

/**
 * 时间格式化选项。
 * 类型用途：控制 formatTime 的输出格式（ISO 标准格式或日志友好格式），作为 formatTime 的参数。
 * 使用范围：仅 helpers 模块内部使用。
 */
export type TimeFormatOptions = {
  readonly format?: 'iso' | 'log';
};

/**
 * 行情显示格式化结果。
 * 类型用途：封装单只标的行情的可读文本字段，供日志和界面展示使用，作为 formatQuoteDisplay 的返回类型。
 * 数据来源：由 formatQuoteDisplay 根据行情快照计算生成。
 * 使用范围：仅 helpers 模块内部使用。
 */
export type QuoteDisplayResult = {
  readonly nameText: string;
  readonly codeText: string;
  readonly priceText: string;
  readonly changeAmountText: string;
  readonly changePercentText: string;
};

/**
 * 指标状态接口。
 * 类型用途：描述单次主循环中各技术指标的当前计算值，用于信号条件评估。
 * 数据来源：由行情服务和指标计算模块填充后传入信号解析器。
 * 使用范围：仅 helpers 模块内部使用。
 */
export type IndicatorState = {
  readonly ema?: Record<number, number> | null;
  readonly rsi?: Record<number, number> | null;
  readonly psy?: Record<number, number> | null;
  readonly mfi?: number | null;
  readonly kdj?: { readonly k?: number; readonly d?: number; readonly j?: number } | null;
  readonly macd?: { readonly macd?: number; readonly dif?: number; readonly dea?: number } | null;
};

// ============= signalConfigParser 类型定义 =============

/**
 * 解析后的单条信号条件。
 * 类型用途：表示从信号配置字符串解析出的单个指标阈值比较条件。
 * 数据来源：由 signalConfigParser 解析 MonitorConfig.signalConfig 字符串生成。
 * 使用范围：仅 helpers 模块内部使用。
 */
export type ParsedCondition = {
  readonly indicator: string;
  readonly period?: number;
  readonly operator: '<' | '>';
  readonly threshold: number;
};

/**
 * 解析后的条件组。
 * 类型用途：表示一组信号条件及其最低满足数量要求，用于多条件联合评估。
 * 数据来源：由 signalConfigParser 解析信号配置后组装。
 * 使用范围：仅 helpers 模块内部使用。
 */
export type ParsedConditionGroup = {
  readonly conditions: ReadonlyArray<ParsedCondition>;
  readonly minSatisfied: number;
};

/**
 * 信号评估结果。
 * 类型用途：记录一次完整信号评估的触发状态、满足的条件组索引及原因描述，作为 evaluateSignalConditions 的返回类型。
 * 数据来源：由 evaluateSignalConditions 计算后返回。
 * 使用范围：仅 helpers 模块内部使用。
 */
export type EvaluationResult = {
  readonly triggered: boolean;
  readonly satisfiedGroupIndex: number;
  readonly satisfiedCount: number;
  readonly reason: string;
};

/**
 * 单个条件组的评估结果。
 * 类型用途：记录单个条件组是否满足及实际满足的条件数量，作为 evaluateConditionGroup 的返回类型。
 * 数据来源：由 evaluateConditionGroup 计算后返回。
 * 使用范围：仅 helpers 模块内部使用。
 */
export type ConditionGroupResult = {
  readonly satisfied: boolean;
  readonly count: number;
};

// ============= tradingTime 类型定义 =============

/**
 * 香港时间结构。
 * 类型用途：表示从 UTC 时间转换后的香港本地小时与分钟，用于交易时段判断，作为 getHKTime 的返回类型。
 * 数据来源：由 getHKTime 从 Date 对象转换生成。
 * 使用范围：仅 helpers 模块内部使用。
 */
export type HKTime = {
  readonly hkHour: number;
  readonly hkMinute: number;
};

/**
 * 交易日历快照中的单日信息。
 * 类型用途：表示某港股日期是否为交易日及是否半日市，供交易时段累计时长计算使用。
 * 数据来源：生命周期阶段预热的交易日历快照。
 * 使用范围：仅 helpers/tradingTime 及其调用方内部使用。
 */
export type TradingCalendarDayInfo = {
  readonly isTradingDay: boolean;
  readonly isHalfDay: boolean;
};

/**
 * 交易日历快照。
 * 类型用途：按港股日期键（YYYY-MM-DD）索引交易日信息，作为交易时段累计时长计算的唯一数据来源。
 * 数据来源：生命周期启动/开盘重建时维护。
 * 使用范围：仅 helpers/tradingTime 及其调用方内部使用。
 */
export type TradingCalendarSnapshot = ReadonlyMap<string, TradingCalendarDayInfo>;

/**
 * 交易时段累计时长计算参数。
 * 类型用途：定义起止时间与交易日历快照输入，供 calculateTradingDurationMsBetween 使用。
 * 数据来源：卖出决策、周期换标等业务层传入。
 * 使用范围：仅 helpers/tradingTime 及其调用方内部使用。
 */
export type TradingDurationBetweenParams = {
  readonly startMs: number;
  readonly endMs: number;
  readonly calendarSnapshot: TradingCalendarSnapshot;
};

/**
 * 持仓超时判定参数。
 * 类型用途：定义订单成交时间、当前时间、超时阈值与交易日历快照输入，供 isOrderTimedOut 使用。
 * 数据来源：智能平仓第三阶段调用方传入。
 * 使用范围：仅 helpers/tradingTime 及其调用方内部使用。
 */
export type OrderTimeoutCheckParams = {
  readonly orderExecutedTimeMs: number;
  readonly nowMs: number;
  readonly timeoutMinutes: number;
  readonly calendarSnapshot: TradingCalendarSnapshot;
};

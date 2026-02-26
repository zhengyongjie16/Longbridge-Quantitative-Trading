/**
 * 香港时间结构。
 * 类型用途：表示从 UTC 时间转换后的香港本地小时与分钟，作为时间工具函数返回值。
 * 数据来源：由 tradingTime 工具基于 Date 计算生成。
 * 使用范围：tradingTime 与依赖其输出的业务模块。
 */
export type HKTime = {
  readonly hkHour: number;
  readonly hkMinute: number;
};

/**
 * 交易会话区间。
 * 类型用途：描述单个交易时段的 UTC 毫秒起止，用于交易时段累计计算。
 * 数据来源：由交易日历与交易时段规则推导。
 * 使用范围：仅 tradingTime 相关计算流程内部与调用方。
 */
export type SessionRange = Readonly<{
  startMs: number;
  endMs: number;
}>;

/**
 * 交易日历快照中的单日信息。
 * 类型用途：表示某港股日期是否交易日及是否半日市。
 * 数据来源：生命周期阶段预热的交易日历快照。
 * 使用范围：交易时段累计、智能平仓、自动换标等依赖交易日历的模块。
 */
export type TradingCalendarDayInfo = {
  readonly isTradingDay: boolean;
  readonly isHalfDay: boolean;
};

/**
 * 交易日历快照。
 * 类型用途：按港股日期键（YYYY-MM-DD）索引交易日信息，作为交易时段计算的唯一输入。
 * 数据来源：生命周期启动/重建时维护。
 * 使用范围：signalProcessor、orderRecorder、autoSymbolManager、tests 等跨模块共享。
 */
export type TradingCalendarSnapshot = ReadonlyMap<string, TradingCalendarDayInfo>;

/**
 * 交易时段累计时长计算参数。
 * 类型用途：定义起止时间与交易日历快照输入，供交易时段累计函数使用。
 * 数据来源：卖出决策、周期换标等业务层构建。
 * 使用范围：tradingTime 及其调用方。
 */
export type TradingDurationBetweenParams = {
  readonly startMs: number;
  readonly endMs: number;
  readonly calendarSnapshot: TradingCalendarSnapshot;
};

/**
 * 持仓超时判定参数。
 * 类型用途：定义订单成交时间、当前时间、超时阈值与交易日历快照输入。
 * 数据来源：智能平仓调用方构建。
 * 使用范围：tradingTime 超时判定逻辑及相关调用方。
 */
export type OrderTimeoutCheckParams = {
  readonly orderExecutedTimeMs: number;
  readonly nowMs: number;
  readonly timeoutMinutes: number;
  readonly calendarSnapshot: TradingCalendarSnapshot;
};

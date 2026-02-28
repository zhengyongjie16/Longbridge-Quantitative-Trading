/**
 * 香港时间结构。
 * 类型用途：表示从 UTC 时间转换后的香港本地小时与分钟，作为时间工具函数返回值。
 * 数据来源：由 tradingTime 工具基于 Date 计算生成。
 * 使用范围：仅 tradingTime 模块内部使用。
 */
export type HKTime = {
  readonly hkHour: number;
  readonly hkMinute: number;
};

/**
 * 交易会话区间。
 * 类型用途：描述单个交易时段的 UTC 毫秒起止，用于交易时段累计计算。
 * 数据来源：由交易日历与交易时段规则推导。
 * 使用范围：仅 tradingTime 模块内部使用。
 */
export type SessionRange = Readonly<{
  startMs: number;
  endMs: number;
}>;

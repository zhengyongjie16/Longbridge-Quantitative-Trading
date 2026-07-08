import type { TradingCalendarSnapshot } from '../../types/tradingCalendar.js';

/**
 * 香港时间结构。
 * 类型用途：表示从 UTC 时间转换后的香港本地小时与分钟，作为时间工具函数返回值。
 * 数据来源：由 time 工具基于 Date 计算生成。
 * 使用范围：仅 time 模块内部使用。
 */
export type HKTime = {
  readonly hkHour: number;
  readonly hkMinute: number;
};

/**
 * 交易会话区间。
 * 类型用途：描述单个交易时段的 UTC 毫秒起止，用于交易时段累计计算。
 * 数据来源：由交易日历与交易时段规则推导。
 * 使用范围：仅 time 模块内部使用。
 */
export type SessionRange = Readonly<{
  startMs: number;
  endMs: number;
}>;

/**
 * 交易时段累计到期时间计算参数。
 * 类型用途：从起点和目标累计交易时长反推到期 UTC 毫秒时间戳。
 * 数据来源：周期换标等调用方传入的基线时间、目标时长与交易日历快照。
 * 使用范围：time 工具函数 calculateTradingDurationDueAtMs。
 */
export type TradingDurationDueAtParams = Readonly<{
  startMs: number;
  targetDurationMs: number;
  calendarSnapshot: TradingCalendarSnapshot;
}>;

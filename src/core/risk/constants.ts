/**
 * 风险控制模块常量定义
 */

/** 牛证最低距离回收价百分比（低于此值停止买入牛证） */
export const BULL_WARRANT_MIN_DISTANCE_PERCENT = 0.5;

/** 熊证最高距离回收价百分比（高于此值停止买入熊证） */
export const BEAR_WARRANT_MAX_DISTANCE_PERCENT = -0.5;

/** 监控标的价格最小有效值（低于此值认为价格异常） */
export const MIN_MONITOR_PRICE_THRESHOLD = 1;

/** 默认价格小数位数 */
export const DEFAULT_PRICE_DECIMALS = 3;

/** 默认百分比小数位数 */
export const DEFAULT_PERCENT_DECIMALS = 2;

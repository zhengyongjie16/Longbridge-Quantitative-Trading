/**
 * 全局常量定义
 * 统一管理项目中使用的所有常量
 */

import type { SignalType } from '../types/index.js';

/**
 * 时间相关常量
 */
export const TIME = {
  /** 每秒的毫秒数 */
  MILLISECONDS_PER_SECOND: 1000,
  /** 北京时区偏移量（毫秒） */
  BEIJING_TIMEZONE_OFFSET_MS: 8 * 60 * 60 * 1000,
} as const;

/**
 * 交易相关常量
 */
export const TRADING = {
  /** 默认目标金额（港币） */
  DEFAULT_TARGET_NOTIONAL: 5000,
  /** K线周期 */
  CANDLE_PERIOD: '1m' as const,
  /** K线数量 */
  CANDLE_COUNT: 200,
  /** 主循环执行间隔（毫秒） */
  INTERVAL_MS: 1000,
} as const;

/**
 * 验证相关常量
 */
export const VERIFICATION = {
  /** 验证时间点1偏移量（秒） */
  TIME_OFFSET_1_SECONDS: 5,
  /** 验证时间点2偏移量（秒） */
  TIME_OFFSET_2_SECONDS: 10,
  /** 验证时间点误差容忍度（毫秒） */
  TIME_TOLERANCE_MS: 5 * 1000,
  /** 验证窗口开始时间偏移量（秒） */
  WINDOW_START_OFFSET_SECONDS: -5,
  /** 验证窗口结束时间偏移量（秒） */
  WINDOW_END_OFFSET_SECONDS: 15,
  /** 验证就绪延迟时间（秒） */
  READY_DELAY_SECONDS: 15,
} as const;

/**
 * 日志相关常量
 */
export const LOGGING = {
  /** 文件流 drain 超时时间（毫秒） */
  DRAIN_TIMEOUT_MS: 5000,
  /** 控制台流 drain 超时时间（毫秒） */
  CONSOLE_DRAIN_TIMEOUT_MS: 3000,
} as const;

/**
 * API 相关常量
 */
export const API = {
  /** 默认重试次数 */
  DEFAULT_RETRY_COUNT: 2,
  /** 默认重试延迟（毫秒） */
  DEFAULT_RETRY_DELAY_MS: 300,
  /** 交易日缓存 TTL（毫秒） */
  TRADING_DAY_CACHE_TTL_MS: 24 * 60 * 60 * 1000,
} as const;

/**
 * 行情监控相关常量
 */
export const MONITOR = {
  /** 价格变化检测阈值 */
  PRICE_CHANGE_THRESHOLD: 0.001,
  /** 技术指标变化检测阈值（EMA/RSI/MFI/KDJ/MACD） */
  INDICATOR_CHANGE_THRESHOLD: 0.001,
  /** 涨跌幅变化检测阈值（百分比） */
  CHANGE_PERCENT_THRESHOLD: 0.01,
} as const;

/**
 * 信号类型常量
 */
export const SIGNAL_ACTIONS = {
  BUYCALL: 'BUYCALL' as const,
  SELLCALL: 'SELLCALL' as const,
  BUYPUT: 'BUYPUT' as const,
  SELLPUT: 'SELLPUT' as const,
  HOLD: 'HOLD' as const,
} as const;

/**
 * 有效的信号操作集合
 */
export const VALID_SIGNAL_ACTIONS = new Set<SignalType>([
  SIGNAL_ACTIONS.BUYCALL,
  SIGNAL_ACTIONS.SELLCALL,
  SIGNAL_ACTIONS.BUYPUT,
  SIGNAL_ACTIONS.SELLPUT,
]);

/**
 * 信号目标操作映射（简化版，用于日志显示）
 * 将信号类型映射到交易操作（买入/卖出）
 */
export const SIGNAL_TARGET_ACTIONS: Record<string, string> = {
  [SIGNAL_ACTIONS.BUYCALL]: '买入',
  [SIGNAL_ACTIONS.SELLCALL]: '卖出',
  [SIGNAL_ACTIONS.BUYPUT]: '买入',
  [SIGNAL_ACTIONS.SELLPUT]: '卖出',
};

/**
 * 日志系统模块类型定义
 */

// 日志级别常量
export const LOG_LEVELS = {
  DEBUG: 20,
  INFO: 30,
  WARN: 40,
  ERROR: 50,
} as const;

export type LogLevel = (typeof LOG_LEVELS)[keyof typeof LOG_LEVELS];

/**
 * 日志对象接口
 */
export type LogObject = {
  readonly level: LogLevel;
  readonly time: number;
  readonly msg: string;
  readonly extra?: unknown;
};

/**
 * Logger 接口定义
 */
export type Logger = {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
};

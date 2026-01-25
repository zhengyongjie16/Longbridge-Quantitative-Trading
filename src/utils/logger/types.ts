/**
 * 日志系统类型定义模块
 *
 * 定义日志系统相关的类型和常量：
 * - LOG_LEVELS：日志级别常量（DEBUG=20, INFO=30, WARN=40, ERROR=50）
 * - LogLevel：日志级别类型
 * - LogObject：日志对象结构
 * - Logger：日志器接口
 */

/** 日志级别常量（pino 自定义级别） */
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

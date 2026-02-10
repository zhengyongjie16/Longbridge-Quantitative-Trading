/**
 * 日志系统类型定义模块
 *
 * 定义日志系统相关的类型：
 * - LogObject：日志对象结构
 * - Logger：日志器接口
 *
 * 日志级别常量 LOG_LEVELS 定义在 src/constants 中，使用处应从 constants 直接引用。
 */
import { LOG_LEVELS } from '../../constants/index.js';

/**
 * 日志对象接口
 */
export type LogObject = {
  readonly level: (typeof LOG_LEVELS)[keyof typeof LOG_LEVELS];
  readonly time: number;
  readonly msg: string;
  readonly extra?: unknown;
};

/**
 * Logger 接口定义
 */
export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

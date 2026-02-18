import { LOG_LEVELS } from '../../constants/index.js';

/**
 * 日志对象接口
 * 用途：描述单条结构化日志记录的数据结构，供日志格式化器序列化输出
 * 数据来源：由 logger 模块各级别方法（debug/info/warn/error）构造生成
 * 使用范围：仅 logger 模块内部使用
 */
export type LogObject = {
  readonly level: (typeof LOG_LEVELS)[keyof typeof LOG_LEVELS];
  readonly time: number;
  readonly msg: string;
  readonly extra?: unknown;
};

/**
 * Logger 接口定义
 * 用途：定义日志记录器的公开方法契约，供业务模块注入和调用
 * 数据来源：由 createLogger 工厂函数实现并返回
 * 使用范围：全局使用，业务模块通过依赖注入获取实例
 */
export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

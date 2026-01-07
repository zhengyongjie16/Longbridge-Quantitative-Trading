/**
 * 指标计算工具函数
 */

import { logger } from '../../utils/logger/index.js';

// 读取DEBUG环境变量
export const IS_DEBUG = process.env['DEBUG'] === 'true';

/**
 * 将值转换为数字
 */
export const toNumber = (value: unknown): number =>
  typeof value === 'number' ? value : Number(value ?? 0);

/**
 * 记录调试日志
 */
export function logDebug(message: string, error?: unknown): void {
  if (IS_DEBUG) {
    logger.debug(message, error);
  }
}

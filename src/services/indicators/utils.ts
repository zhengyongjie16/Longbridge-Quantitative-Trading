/**
 * 指标计算工具函数
 */

import { logger } from '../../utils/logger/index.js';
import type { CandleValue } from '../../types/index.js';

// 读取DEBUG环境变量
const IS_DEBUG = process.env['DEBUG'] === 'true';

/**
 * 将 K 线数据值转换为数字
 * @param value K 线数据值（支持 Decimal、number、string）
 * @returns 数字值，无效值返回 0
 */
export const toNumber = (value: CandleValue): number => {
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    return Number(value);
  }
  // Decimal 类型：使用 toString() 转换
  return Number(value.toString());
};

/**
 * 记录调试日志
 */
export function logDebug(message: string, error?: unknown): void {
  if (IS_DEBUG) {
    logger.debug(message, error);
  }
}

/**
 * 指标计算工具函数
 */

import { logger } from '../../utils/logger/index.js';
import type { CandleValue } from '../../types/index.js';
import type { PoolableKDJ, PoolableMACD } from '../../utils/objectPool/types.js';

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

/**
 * 验证百分比值是否有效（0-100）
 * @param value 百分比值
 * @returns 如果值在 0-100 范围内返回 true，否则返回 false
 */
export function validatePercentage(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

/**
 * 检查 PoolableKDJ 是否可以安全转换为 KDJIndicator
 * @param obj 对象池中的 KDJ 对象
 * @returns 如果所有字段都是有效数字则返回 true
 */
export const isValidKDJ = (
  obj: PoolableKDJ,
): obj is PoolableKDJ & { k: number; d: number; j: number } => {
  return (
    typeof obj.k === 'number' &&
    typeof obj.d === 'number' &&
    typeof obj.j === 'number' &&
    Number.isFinite(obj.k) &&
    Number.isFinite(obj.d) &&
    Number.isFinite(obj.j)
  );
};

/**
 * 检查 PoolableMACD 是否可以安全转换为 MACDIndicator
 * @param obj 对象池中的 MACD 对象
 * @returns 如果所有字段都是有效数字则返回 true
 */
export const isValidMACD = (
  obj: PoolableMACD,
): obj is PoolableMACD & { macd: number; dif: number; dea: number } => {
  return (
    typeof obj.macd === 'number' &&
    typeof obj.dif === 'number' &&
    typeof obj.dea === 'number' &&
    Number.isFinite(obj.macd) &&
    Number.isFinite(obj.dif) &&
    Number.isFinite(obj.dea)
  );
};

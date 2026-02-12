/**
 * 指标计算模块的工具函数
 *
 * 功能：
 * - K 线数据类型转换（toNumber）
 * - K 线指纹（getCandleFingerprint）供 pipeline 判断是否复用快照
 * - 调试日志输出（logDebug）
 * - 对象池类型验证（isValidKDJ、isValidMACD）
 */
import { IS_DEBUG } from '../../constants/index.js';
import { isValidPositiveNumber } from '../../utils/helpers/index.js';
import { logger } from '../../utils/logger/index.js';
import type { CandleData, CandleValue } from '../../types/data.js';
import type { PoolableKDJ, PoolableMACD } from '../../utils/objectPool/types.js';

/** K 线数据指纹：length_lastClose，用于检测数据是否变化 */
function buildDataFingerprint(
  candles: ReadonlyArray<CandleData>,
  lastClose: number,
): string {
  return `${candles.length}_${lastClose}`;
}

/**
 * 从 K 线计算指纹，供 pipeline 判断是否可复用上一拍快照。
 * 仅当最后一根收盘价有效时返回非 null。
 */
export function getCandleFingerprint(candles: ReadonlyArray<CandleData>): string | null {
  if (!candles || candles.length === 0) {
    return null;
  }
  const lastCandle = candles.at(-1);
  const lastClose = lastCandle ? toNumber(lastCandle.close) : 0;
  if (!isValidPositiveNumber(lastClose)) {
    return null;
  }
  return buildDataFingerprint(candles, lastClose);
}

/**
 * 将 K 线数据值转换为数字
 * @param value K 线数据值（支持 Decimal、number、string）
 * @returns 数字值，无效值返回 0
 */
export function toNumber(value: CandleValue): number {
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
}

/**
 * 记录调试日志
 */
export function logDebug(message: string, error?: unknown): void {
  if (IS_DEBUG) {
    logger.debug(message, error);
  }
}

/**
 * 检查 PoolableKDJ 是否可以安全转换为 KDJIndicator
 * @param obj 对象池中的 KDJ 对象
 * @returns 如果所有字段都是有效数字则返回 true
 */
export function isValidKDJ(
  obj: PoolableKDJ,
): obj is PoolableKDJ & { k: number; d: number; j: number } {
  return (
    typeof obj.k === 'number' &&
    typeof obj.d === 'number' &&
    typeof obj.j === 'number' &&
    Number.isFinite(obj.k) &&
    Number.isFinite(obj.d) &&
    Number.isFinite(obj.j)
  );
}

/**
 * 检查 PoolableMACD 是否可以安全转换为 MACDIndicator
 * @param obj 对象池中的 MACD 对象
 * @returns 如果所有字段都是有效数字则返回 true
 */
export function isValidMACD(
  obj: PoolableMACD,
): obj is PoolableMACD & { macd: number; dif: number; dea: number } {
  return (
    typeof obj.macd === 'number' &&
    typeof obj.dif === 'number' &&
    typeof obj.dea === 'number' &&
    Number.isFinite(obj.macd) &&
    Number.isFinite(obj.dif) &&
    Number.isFinite(obj.dea)
  );
}

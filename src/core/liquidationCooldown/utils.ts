/**
 * 清仓冷却模块工具函数
 */

import type { LiquidationDirection } from './types.js';

/**
 * 构建冷却记录的 key
 */
export function buildCooldownKey(symbol: string, direction: LiquidationDirection): string {
  return `${symbol}:${direction}`;
}

/**
 * 将分钟转换为毫秒，非正数返回 0
 */
export function convertMinutesToMs(minutes: number): number {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return 0;
  }
  return Math.floor(minutes * 60_000);
}

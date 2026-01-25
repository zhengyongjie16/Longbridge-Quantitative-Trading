/**
 * @module processMonitor/utils
 * @description processMonitor 模块的工具函数
 *
 * 提供持仓查询等辅助功能，与对象池配合使用
 */

import { positionObjectPool } from '../../utils/objectPool/index.js';
import type { Position, PositionCache } from '../../types/index.js';

/**
 * 从持仓缓存中获取指定标的的持仓
 *
 * 使用 PositionCache 提供 O(1) 查找，并从对象池获取 Position 对象
 * 注意：调用方需负责释放返回的 Position 对象到对象池
 *
 * @param positionCache 持仓缓存（O(1) 查找）
 * @param longSymbol 做多标的代码
 * @param shortSymbol 做空标的代码
 * @returns longPosition 和 shortPosition，无持仓时为 null
 */
export function getPositions(
  positionCache: PositionCache,
  longSymbol: string,
  shortSymbol: string,
): { longPosition: Position | null; shortPosition: Position | null } {
  // O(1) 查找
  const longPos = positionCache.get(longSymbol);
  const shortPos = positionCache.get(shortSymbol);

  let longPosition: Position | null = null;
  let shortPosition: Position | null = null;

  // 创建持仓对象（复用对象池）
  if (longPos) {
    longPosition = positionObjectPool.acquire() as Position;
    longPosition.symbol = longSymbol;
    longPosition.costPrice = Number(longPos.costPrice) || 0;
    longPosition.quantity = Number(longPos.quantity) || 0;
    longPosition.availableQuantity = Number(longPos.availableQuantity) || 0;
    longPosition.accountChannel = longPos.accountChannel;
    longPosition.symbolName = longPos.symbolName;
    longPosition.currency = longPos.currency;
    longPosition.market = longPos.market;
  }

  if (shortPos) {
    shortPosition = positionObjectPool.acquire() as Position;
    shortPosition.symbol = shortSymbol;
    shortPosition.costPrice = Number(shortPos.costPrice) || 0;
    shortPosition.quantity = Number(shortPos.quantity) || 0;
    shortPosition.availableQuantity = Number(shortPos.availableQuantity) || 0;
    shortPosition.accountChannel = shortPos.accountChannel;
    shortPosition.symbolName = shortPos.symbolName;
    shortPosition.currency = shortPos.currency;
    shortPosition.market = shortPos.market;
  }

  return { longPosition, shortPosition };
}

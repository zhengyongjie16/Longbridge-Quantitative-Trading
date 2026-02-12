/**
 * 持仓缓存管理模块
 *
 * 使用 Map 提供 O(1) 持仓查找，在持仓数组更新时同步刷新。
 * 主循环中根据标的代码快速查找持仓。
 */
import { isValidPositiveNumber } from './index.js';
import type { Position } from '../../types/account.js';
import type { PositionCache } from '../../types/services.js';

/** 创建持仓缓存管理器 */
export function createPositionCache(): PositionCache {
  const positionMap = new Map<string, Position>();

  /** 用持仓数组替换缓存内容（仅缓存可用数量 > 0 的持仓） */
  function update(positions: ReadonlyArray<Position>): void {
    positionMap.clear();

    for (const pos of positions) {
      if (!pos?.symbol || typeof pos.symbol !== 'string') {
        continue;
      }

      const availableQty = Number(pos.availableQuantity) || 0;
      if (isValidPositiveNumber(availableQty)) {
        positionMap.set(pos.symbol, pos);
      }
    }
  }

  /** 获取指定标的的持仓，不存在返回 null */
  function get(symbol: string): Position | null {
    return positionMap.get(symbol) ?? null;
  }

  return {
    update,
    get,
  };
}

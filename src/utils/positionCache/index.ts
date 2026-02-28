import type { Position } from '../../types/account.js';
import type { PositionCache } from '../../types/services.js';
import { isValidPositiveNumber } from '../helpers/index.js';

/**
 * 创建持仓缓存管理器，使用 Map 提供 O(1) 按标的代码查找。
 * 默认行为：update 时仅缓存可用数量大于 0 的持仓，get 不存在时返回 null。
 *
 * @returns PositionCache 实例，包含 update、get 方法
 */
export function createPositionCache(): PositionCache {
  const positionMap = new Map<string, Position>();

  /**
   * 用最新持仓列表重建缓存。
   * @param positions 当前持仓快照
   * @returns 无返回值
   */
  function update(positions: ReadonlyArray<Position>): void {
    positionMap.clear();

    for (const position of positions) {
      if (position.symbol.length === 0) {
        continue;
      }

      const availableQuantity = position.availableQuantity || 0;
      if (isValidPositiveNumber(availableQuantity)) {
        positionMap.set(position.symbol, position);
      }
    }
  }

  /**
   * 按标的代码读取缓存持仓。
   * @param symbol 标的代码
   * @returns 命中时返回持仓，否则返回 null
   */
  function get(symbol: string): Position | null {
    return positionMap.get(symbol) ?? null;
  }

  return {
    update,
    get,
  };
}

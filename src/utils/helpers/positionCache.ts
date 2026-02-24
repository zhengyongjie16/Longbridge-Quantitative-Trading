import { isValidPositiveNumber } from './index.js';
import type { Position } from '../../types/account.js';
import type { PositionCache } from '../../types/services.js';

/**
 * 创建持仓缓存管理器，使用 Map 提供 O(1) 按标的代码查找。默认行为：update 时仅缓存可用数量大于 0 的持仓，get 不存在时返回 null。
 *
 * @returns PositionCache 实例，包含 update、get 方法
 */
export function createPositionCache(): PositionCache {
  const positionMap = new Map<string, Position>();

  /**
   * 用持仓数组替换缓存内容，仅缓存可用数量大于 0 的持仓。
   *
   * @param positions 新的持仓数组
   * @returns 无返回值
   */
  function update(positions: ReadonlyArray<Position>): void {
    positionMap.clear();

    for (const pos of positions) {
      if (pos.symbol.length === 0) {
        continue;
      }

      const availableQty = pos.availableQuantity || 0;
      if (isValidPositiveNumber(availableQty)) {
        positionMap.set(pos.symbol, pos);
      }
    }
  }

  /**
   * 获取指定标的的持仓。
   *
   * @param symbol 标的代码
   * @returns 持仓信息，不存在时返回 null
   */
  function get(symbol: string): Position | null {
    return positionMap.get(symbol) ?? null;
  }

  return {
    update,
    get,
  };
}

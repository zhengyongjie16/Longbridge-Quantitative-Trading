/**
 * 持仓缓存管理模块
 *
 * 功能：
 * - 使用 Map 提供 O(1) 持仓查找性能
 * - 在持仓数组更新时同步刷新缓存
 * - 避免每次查找都执行额外的标的处理
 *
 * 使用场景：
 * - 主循环中 getPositions 函数查找指定标的持仓
 * - 多监控标的场景下提升查找效率
 *
 * - 查找时间复杂度从 O(n) 降至 O(1)
 * - 标的格式校验仅在配置验证阶段执行
 */
import { isValidPositiveNumber } from './index.js';
import type { Position, PositionCache } from '../../types/index.js';

/**
 * 创建持仓缓存管理器
 * 使用工厂函数模式，符合项目规范
 */
export function createPositionCache(): PositionCache {
  const positionMap = new Map<string, Position>();

  /**
   * 更新持仓缓存
   * @param positions 持仓数组
   */
  function update(positions: ReadonlyArray<Position>): void {
    positionMap.clear();

    for (const pos of positions) {
      if (!pos?.symbol || typeof pos.symbol !== 'string') {
        continue;
      }

      const availableQty = Number(pos.availableQuantity) || 0;

      // 只缓存可用数量大于 0 的持仓
      if (isValidPositiveNumber(availableQty)) {
        positionMap.set(pos.symbol, pos);
      }
    }
  }

  /**
   * 获取指定标的的持仓（O(1) 查找）
   * @param symbol 标的代码（已验证 ticker.region）
   */
  function get(symbol: string): Position | null {
    return positionMap.get(symbol) ?? null;
  }

  return {
    update,
    get,
  };
}

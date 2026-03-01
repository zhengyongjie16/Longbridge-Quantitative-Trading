/**
 * 订单缓存域（CacheDomain: order）
 *
 * 午夜清理：
 * - 重置交易执行器的运行时状态（订单追踪、持有标的集合等）
 *
 * 开盘重建：
 * - 订单数据在统一 rebuildTradingDayState 中从 API 重新加载和重建，此处为空操作
 */
import { logger } from '../../../utils/logger/index.js';
import type { CacheDomain } from '../types.js';
import type { OrderDomainDeps } from './types.js';

/**
 * 创建订单缓存域。
 * 午夜清理时重置交易执行器运行时状态；开盘重建由统一 rebuildTradingDayState 负责，本域为空操作。
 *
 * @param deps 依赖注入，包含 trader
 * @returns 实现 CacheDomain 的订单域实例
 */
export function createOrderDomain(deps: OrderDomainDeps): CacheDomain {
  const { trader } = deps;
  return {

    /**
     * 午夜清理：重置交易执行器的运行时状态（订单追踪、持有标的集合等），
     * 确保跨日后不残留前一交易日的订单状态。
     */
    midnightClear(): void {
      trader.resetRuntimeState();
      logger.info('[Lifecycle][order] 午夜清理完成');
    },

    /**
     * 开盘重建：订单数据由统一 rebuildTradingDayState 负责重建，此处为空操作。
     */
    openRebuild(): void {
      // 订单重建在统一 rebuildTradingDayState 中执行
    },
  };
}

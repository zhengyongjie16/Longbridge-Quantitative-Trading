/**
 * 订单缓存域（CacheDomain: order）
 *
 * 午夜清理：
 * - 仅重置交易执行器的运行时状态（订单追踪、持有标的集合等）
 * - 订单监控 runtime 的启停 owner 已收口到 signalRuntimeDomain
 *
 * 开盘重建：
 * - 订单数据在统一 rebuildTradingDayState 中从 API 重新加载和重建
 * - 本域不再直接持有订单监控 runtime owner
 */
import { logger } from '../../../utils/logger/index.js';
import type { CacheDomain } from '../types.js';
import type { OrderDomainDeps } from './types.js';

/**
 * 创建订单缓存域。
 * 午夜清理时仅重置交易执行器运行时状态；订单监控 runtime 的启停由 signalRuntimeDomain 统一负责。
 *
 * @param deps 依赖注入，包含 trader
 * @returns 实现 CacheDomain 的订单域实例
 */
export function createOrderDomain(deps: OrderDomainDeps): CacheDomain {
  const { trader } = deps;
  return {
    /**
     * 午夜清理：订单监控 runtime 已由 signalRuntimeDomain 先行停止，本域仅重置 trader 运行态，
     * 确保跨日后不残留前一交易日的订单追踪与持有标的状态。
     */
    midnightClear(): void {
      trader.resetRuntimeState();
      logger.debug('[Lifecycle][order] trader 运行态已重置');
    },

    /**
     * 开盘重建：订单数据由统一 rebuildTradingDayState 负责重建，订单监控 runtime 由 signalRuntimeDomain 启动。
     */
    openRebuild(): void {
      logger.debug('[Lifecycle][order] 开盘重建跳过 runtime 启停，等待 signalRuntimeDomain 接管');
    },
  };
}

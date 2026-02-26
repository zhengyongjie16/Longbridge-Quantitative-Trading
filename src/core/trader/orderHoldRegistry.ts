/**
 * 订单保留集管理模块
 *
 * 职责：
 * - 追踪未成交订单，维护 symbol -> orderId 的双向索引
 * - 用于限制重复交易或快速判断是否存在未完成订单
 *
 * 数据结构：
 * - orderIdToSymbol: Map<orderId, symbol> - 订单ID到标的的映射
 * - orderIdsBySymbol: Map<symbol, Set<orderId>> - 标的到所有订单ID的映射
 * - holdSymbols: Set<symbol> - 存在未成交订单的标的集合
 *
 * 使用场景：
 * - 启动时从已有订单列表初始化保留集（seedFromOrders）
 * - 订单提交后追踪订单与标的的关联（trackOrder）
 * - 订单关闭后清理索引，若标的无剩余未成交订单则移除（markOrderClosed）
 */
import { PENDING_ORDER_STATUSES } from '../../constants/index.js';
import type { RawOrderFromAPI } from '../../types/services.js';
import type { OrderHoldRegistry } from './types.js';

/**
 * 创建订单订阅保留集管理器。
 * 维护 orderId↔symbol 双向索引与 holdSymbols 集合，提供 trackOrder、markOrderClosed、seedFromOrders、getHoldSymbols、clear。
 * OrderMonitor 需知道哪些标的有未成交订单以持续订阅行情，成交后移除；启动时从历史订单恢复保留集。
 * @returns 实现 OrderHoldRegistry 接口的实例（无外部依赖）
 */
export function createOrderHoldRegistry(): OrderHoldRegistry {
  const orderIdToSymbol = new Map<string, string>();
  const orderIdsBySymbol = new Map<string, Set<string>>();
  const holdSymbols = new Set<string>();

  /**
   * 追踪订单与标的的关联，建立双向索引。
   * 同一订单重复调用时幂等处理，避免索引污染。
   */
  function trackOrder(orderId: string, symbol: string): void {
    if (!orderId || !symbol) {
      return;
    }
    if (orderIdToSymbol.has(orderId)) {
      return;
    }
    orderIdToSymbol.set(orderId, symbol);

    let symbolOrders = orderIdsBySymbol.get(symbol);
    if (!symbolOrders) {
      symbolOrders = new Set<string>();
      orderIdsBySymbol.set(symbol, symbolOrders);
    }
    symbolOrders.add(orderId);
    holdSymbols.add(symbol);
  }

  /**
   * 订单关闭后清理双向索引（成交/撤销/拒绝/主动撤单成功）。
   * 若该标的已无其他未成交订单，同步从 holdSymbols 中移除，避免误判持仓状态。
   */
  function markOrderClosed(orderId: string): void {
    const symbol = orderIdToSymbol.get(orderId);
    if (!symbol) {
      return;
    }
    orderIdToSymbol.delete(orderId);

    const symbolOrders = orderIdsBySymbol.get(symbol);
    if (!symbolOrders) {
      return;
    }
    symbolOrders.delete(orderId);
    if (symbolOrders.size === 0) {
      orderIdsBySymbol.delete(symbol);
      holdSymbols.delete(symbol);
    }
  }

  /**
   * 程序启动时从已有订单列表初始化保留集。
   * 仅处理状态为未成交的订单，确保重启后能正确恢复持仓追踪状态。
   */
  function seedFromOrders(orders: ReadonlyArray<RawOrderFromAPI>): void {
    for (const order of orders) {
      if (!order.symbol) {
        continue;
      }
      if (!PENDING_ORDER_STATUSES.has(order.status)) {
        continue;
      }
      trackOrder(order.orderId, order.symbol);
    }
  }

  /**
   * 返回当前存在未成交订单的标的集合。
   * 供外部快速判断某标的是否有挂单，避免重复查询 API。
   */
  function getHoldSymbols(): ReadonlySet<string> {
    return holdSymbols;
  }

  /**
   * 清空内部所有索引（测试或跨日重置时使用）。
   */
  function clear(): void {
    orderIdToSymbol.clear();
    orderIdsBySymbol.clear();
    holdSymbols.clear();
  }

  return {
    trackOrder,
    markOrderClosed,
    seedFromOrders,
    getHoldSymbols,
    clear,
  };
}

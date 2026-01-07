/**
 * 订单过滤算法引擎
 *
 * 职责：
 * - 实现复杂的订单过滤算法（智能清仓决策）
 * - 无状态，纯函数式设计
 * - 易于单元测试
 *
 * 过滤算法：
 * 1. M0：最新卖出时间之后成交的买入订单
 * 2. 过滤历史高价买入且未被完全卖出的订单
 * 3. 最终记录 = M0 + 过滤后的买入订单
 */

import type { OrderRecord, FilteringState, OrderFilteringEngine, OrderFilteringEngineDeps } from './type.js';

/**
 * 创建订单过滤引擎
 * @param _deps 依赖注入（当前为空）
 * @returns OrderFilteringEngine 接口实例
 */
export const createOrderFilteringEngine = (_deps: OrderFilteringEngineDeps = {}): OrderFilteringEngine => {
  /**
   * 计算订单列表的总成交数量（内部辅助方法）
   */
  const calculateTotalQuantity = (orders: OrderRecord[]): number => {
    return orders.reduce((sum, order) => {
      return sum + (order.executedQuantity || 0);
    }, 0);
  };

  /**
   * 初始化过滤状态
   */
  const initializeFilteringState = (
    allBuyOrders: OrderRecord[],
    sortedSellOrders: OrderRecord[],
  ): FilteringState | null => {
    const lastSellOrder = sortedSellOrders.at(-1);
    if (!lastSellOrder) {
      return null;
    }

    const latestSellTime = lastSellOrder.executedTime;

    // M0: 成交时间 > 最新卖出订单时间的买入订单
    const m0Orders = allBuyOrders.filter(
      (buyOrder) => buyOrder.executedTime > latestSellTime,
    );

    // 候选订单：成交时间 <= 最新卖出订单时间的买入订单
    const candidateOrders = allBuyOrders.filter(
      (buyOrder) => buyOrder.executedTime <= latestSellTime,
    );

    return { m0Orders, candidateOrders };
  };

  /**
   * 应用单个卖出订单的过滤
   */
  const applySingleSellOrderFilter = (
    currentBuyOrders: OrderRecord[],
    sellOrder: OrderRecord,
    nextSellOrder: OrderRecord | null,
    latestSellTime: number,
  ): OrderRecord[] => {
    const sellTime = sellOrder.executedTime;
    const sellPrice = sellOrder.executedPrice;
    const sellQuantity = sellOrder.executedQuantity;

    const nextSellTime = nextSellOrder
      ? nextSellOrder.executedTime
      : latestSellTime + 1;

    // 获取成交时间 < 当前卖出订单时间的买入订单
    const buyOrdersBeforeSell = currentBuyOrders.filter(
      (buyOrder) => buyOrder.executedTime < sellTime,
    );

    // 判断是否全部卖出
    const quantityToCompare = calculateTotalQuantity(buyOrdersBeforeSell);

    if (sellQuantity >= quantityToCompare) {
      // 全部卖出，移除这些订单
      return currentBuyOrders.filter(
        (buyOrder) => buyOrder.executedTime >= sellTime,
      );
    }

    if (buyOrdersBeforeSell.length === 0) {
      // 没有在此卖出订单之前的买入订单
      return currentBuyOrders.filter(
        (buyOrder) => buyOrder.executedTime >= sellTime,
      );
    }

    // 按价格过滤
    const filteredBuyOrders = buyOrdersBeforeSell.filter(
      (buyOrder) => buyOrder.executedPrice >= sellPrice,
    );

    // 获取时间范围内的买入订单
    const buyOrdersBetweenSells = currentBuyOrders.filter(
      (buyOrder) =>
        buyOrder.executedTime > sellTime &&
        buyOrder.executedTime < nextSellTime,
    );

    // 合并结果
    return [...filteredBuyOrders, ...buyOrdersBetweenSells];
  };

  /**
   * 依次应用每个卖出订单的过滤
   */
  const applySequentialFiltering = (
    state: FilteringState,
    sortedSellOrders: OrderRecord[],
  ): OrderRecord[] => {
    let currentBuyOrders = [...state.candidateOrders];

    for (let i = 0; i < sortedSellOrders.length; i++) {
      const sellOrder = sortedSellOrders[i];
      if (!sellOrder) {
        continue;
      }

      currentBuyOrders = applySingleSellOrderFilter(
        currentBuyOrders,
        sellOrder,
        sortedSellOrders[i + 1] ?? null,
        sortedSellOrders.at(-1)!.executedTime,
      );
    }

    return currentBuyOrders;
  };

  /**
   * 应用订单过滤算法
   */
  const applyFilteringAlgorithm = (
    allBuyOrders: OrderRecord[],
    filledSellOrders: OrderRecord[],
  ): OrderRecord[] => {
    // 将卖出订单按成交时间从旧到新排序
    const sortedSellOrders = [...filledSellOrders].sort(
      (a, b) => a.executedTime - b.executedTime,
    );

    if (sortedSellOrders.length === 0) {
      return allBuyOrders;
    }

    // 获取初始状态（M0 和候选订单）
    const state = initializeFilteringState(allBuyOrders, sortedSellOrders);

    if (!state) {
      return allBuyOrders;
    }

    // 依次应用每个卖出订单的过滤
    const filteredOrders = applySequentialFiltering(state, sortedSellOrders);

    // 合并 M0 和过滤后的订单
    return [...state.m0Orders, ...filteredOrders];
  };

  return {
    applyFilteringAlgorithm,
  };
};

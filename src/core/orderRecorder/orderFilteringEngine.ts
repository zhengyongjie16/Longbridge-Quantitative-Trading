/**
 * 订单过滤算法引擎
 *
 * 职责：
 * - 实现复杂的订单过滤算法（智能清仓决策）
 * - 无状态，纯函数式设计
 * - 易于单元测试
 *
 * 过滤算法（从旧到新累积过滤）：
 * 1. M0：成交时间 > 最新卖出订单时间的买入订单（无条件保留）
 * 2. 从最旧的卖出订单 D1 开始依次处理：
 *    - 获取成交时间 < D1 的买入订单
 *    - 若 D1 数量 >= 这些买入订单总量，视为全部卖出
 *    - 否则按价格过滤：保留成交价 >= D1 价格的订单
 *    - M1 = 过滤结果 + 成交时间在 (D1, D2) 之间的买入订单（从原始候选订单获取）
 * 3. 对 D2 使用 M1 重复上述过程，得到 M2，以此类推
 * 4. 最终记录 = M0 + MN
 *
 * 关键约束：
 * - 必须按时间顺序从旧到新处理卖出订单
 * - 每轮过滤基于上一轮的结果（累积过滤）
 * - 时间间隔订单必须从原始候选订单获取，而非上一轮结果
 * - 当按价格过滤后保留数量仍超过应保留数量时，按价格从高到低贪心保留（订单不可拆分）
 */

import type { OrderRecord } from '../../types/index.js';
import type { FilteringState, OrderFilteringEngine, OrderFilteringEngineDeps } from './types.js';
import { calculateTotalQuantity } from './utils.js';

/** 创建订单过滤引擎 */
export const createOrderFilteringEngine = (_deps: OrderFilteringEngineDeps = {}): OrderFilteringEngine => {
  /**
   * 初始化过滤状态
   * - M0: 最新卖出后的买入订单（无条件保留）
   * - candidateOrders: 需要过滤的候选订单
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
    const m0Orders: OrderRecord[] = [];

    // 候选订单：成交时间 <= 最新卖出订单时间的买入订单
    const candidateOrders: OrderRecord[] = [];

    for (const buyOrder of allBuyOrders) {
      if (buyOrder.executedTime > latestSellTime) {
        m0Orders.push(buyOrder);
        continue;
      }

      candidateOrders.push(buyOrder);
    }

    return { m0Orders, candidateOrders };
  };

  /**
   * 按数量限制调整订单列表
   * 当按价格过滤后保留数量超过限制时，优先保留高价订单（亏损订单）
   */
  const adjustOrdersByQuantityLimit = (
    orders: OrderRecord[],
    maxQuantity: number,
  ): OrderRecord[] => {
    // 如果应保留数量 <= 0，全部移除
    if (maxQuantity <= 0) {
      return [];
    }

    const currentQuantity = calculateTotalQuantity(orders);

    // 如果当前数量已经 <= 应保留数量，无需调整
    if (currentQuantity <= maxQuantity) {
      return orders;
    }

    // 按价格从高到低排序（保留高价订单，因为它们是亏损的，应该最后被卖出）
    const sortedByPriceDesc = [...orders].sort(
      (a, b) => b.executedPrice - a.executedPrice,
    );

    // 从高价开始累积，直到达到 maxQuantity
    const result: OrderRecord[] = [];
    let accumulatedQuantity = 0;

    for (const order of sortedByPriceDesc) {
      // 已达到最大数量，停止添加
      if (accumulatedQuantity >= maxQuantity) {
        break;
      }

      // 如果加入这个订单后超过限制，跳过（订单不可拆分）
      if (accumulatedQuantity + order.executedQuantity > maxQuantity) {
        continue;
      }

      result.push(order);
      accumulatedQuantity += order.executedQuantity;
    }

    return result;
  };

  /**
   * 应用单个卖出订单的过滤
   * 1. 获取成交时间 < 卖出时间的买入订单
   * 2. 卖出数量 >= 买入总量：视为全部卖出
   * 3. 否则按价格过滤：保留成交价 >= 卖出价的订单
   * 4. 合并时间间隔内的订单作为下一轮输入
   */
  const applySingleSellOrderFilter = (
    currentBuyOrders: OrderRecord[],
    candidateOrders: ReadonlyArray<OrderRecord>,
    sellOrder: OrderRecord,
    nextSellOrder: OrderRecord | null,
    latestSellTime: number,
  ): OrderRecord[] => {
    const sellTime = sellOrder.executedTime;
    const sellPrice = sellOrder.executedPrice;
    const sellQuantity = sellOrder.executedQuantity;

    // 下一个卖出订单的时间（用于确定时间间隔）
    const nextSellTime = nextSellOrder
      ? nextSellOrder.executedTime
      : latestSellTime + 1;

    // 步骤1：获取成交时间 < 当前卖出订单时间的买入订单
    // 使用 < 以保持开区间边界
    const buyOrdersBeforeSell = currentBuyOrders.filter(
      (buyOrder) => buyOrder.executedTime < sellTime,
    );

    // 计算这些买入订单的总数量
    const totalBuyQuantity = calculateTotalQuantity(buyOrdersBeforeSell);

    // 步骤2：从原始候选订单获取时间间隔内的买入订单（开区间）
    // 时间间隔订单需从候选订单中获取，避免遗漏
    const buyOrdersBetweenSells = candidateOrders.filter(
      (buyOrder) =>
        buyOrder.executedTime > sellTime &&
        buyOrder.executedTime < nextSellTime,
    );

    // 步骤3：判断是否全部卖出
    if (sellQuantity >= totalBuyQuantity) {
      // 全部卖出，移除所有 < sellTime 的订单
      // 只保留时间间隔内的订单
      return [...buyOrdersBetweenSells];
    }

    // 如果没有需要过滤的订单
    if (buyOrdersBeforeSell.length === 0) {
      // 只保留时间间隔内的订单
      return [...buyOrdersBetweenSells];
    }

    // 步骤4：计算应该保留的最大数量
    const maxRetainQuantity = totalBuyQuantity - sellQuantity;

    // 步骤5：按价格过滤 - 保留成交价 >= 卖出价的订单（亏损订单优先保留）
    let filteredBuyOrders = buyOrdersBeforeSell.filter(
      (buyOrder) => buyOrder.executedPrice >= sellPrice,
    );

    // 步骤6：确保保留数量不超过应保留数量
    // 当卖出价格很低时，按价格过滤可能会保留过多订单
    // 需要进一步按价格从低到高移除多余订单
    filteredBuyOrders = adjustOrdersByQuantityLimit(
      filteredBuyOrders,
      maxRetainQuantity,
    );

    // 合并结果：过滤后的订单 + 时间间隔内的订单
    return [...filteredBuyOrders, ...buyOrdersBetweenSells];
  };

  /**
   * 依次应用每个卖出订单的过滤（从旧到新累积）
   * 每轮基于上一轮结果过滤，时间间隔订单从原始候选获取
   */
  const applySequentialFiltering = (
    state: FilteringState,
    sortedSellOrders: OrderRecord[],
  ): OrderRecord[] => {
    // 获取第一个卖出订单的时间
    const firstSellTime = sortedSellOrders[0]?.executedTime ?? 0;

    // 初始订单：成交时间 < 第一个卖出订单时间的买入订单
    let currentBuyOrders = state.candidateOrders.filter(
      (buyOrder) => buyOrder.executedTime < firstSellTime,
    );

    // 按时间顺序处理每个卖出订单
    for (let i = 0; i < sortedSellOrders.length; i++) {
      const sellOrder = sortedSellOrders[i];
      if (!sellOrder) {
        continue;
      }

      // 应用当前卖出订单的过滤
      // 关键：传入原始候选订单，用于获取时间间隔内的订单
      currentBuyOrders = applySingleSellOrderFilter(
        currentBuyOrders,
        state.candidateOrders,
        sellOrder,
        sortedSellOrders[i + 1] ?? null,
        sortedSellOrders.at(-1)!.executedTime,
      );
    }

    return currentBuyOrders;
  };

  /**
   * 应用订单过滤算法（主入口）
   * 按时间顺序处理卖出订单，返回当前仍持有的买入订单
   */
  const applyFilteringAlgorithm = (
    allBuyOrders: OrderRecord[],
    filledSellOrders: OrderRecord[],
  ): OrderRecord[] => {
    // 将卖出订单按成交时间从旧到新排序（D1 → D2 → D3 → ...）
    const sortedSellOrders = [...filledSellOrders].sort(
      (a, b) => a.executedTime - b.executedTime,
    );

    // 如果没有卖出订单，保留所有买入订单
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

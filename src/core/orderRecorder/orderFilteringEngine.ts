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

/**
 * 初始化过滤状态
 * - M0: 最新卖出时间之后成交的买入订单（无条件保留）
 * - candidateOrders: 需要过滤的候选订单
 */
function initializeFilteringState(
  allBuyOrders: OrderRecord[],
  sortedSellOrders: OrderRecord[],
): FilteringState | null {
  const lastSellOrder = sortedSellOrders.at(-1);
  if (!lastSellOrder) {
    return null;
  }

  const latestSellTime = lastSellOrder.executedTime;

  const m0Orders: OrderRecord[] = [];
  const candidateOrders: OrderRecord[] = [];

  for (const buyOrder of allBuyOrders) {
    if (buyOrder.executedTime > latestSellTime) {
      m0Orders.push(buyOrder);
      continue;
    }

    candidateOrders.push(buyOrder);
  }

  return { m0Orders, candidateOrders };
}

/**
 * 按数量限制调整订单列表
 * 当按价格过滤后保留数量超过限制时，按成交价从高到低贪心保留（订单不可拆分）
 */
function adjustOrdersByQuantityLimit(
  orders: OrderRecord[],
  maxQuantity: number,
): OrderRecord[] {
  if (maxQuantity <= 0) {
    return [];
  }

  const currentQuantity = calculateTotalQuantity(orders);

  if (currentQuantity <= maxQuantity) {
    return orders;
  }

  const sortedByPriceDesc = [...orders].sort(
    (a, b) => b.executedPrice - a.executedPrice,
  );

  const result: OrderRecord[] = [];
  let accumulatedQuantity = 0;

  for (const order of sortedByPriceDesc) {
    if (accumulatedQuantity >= maxQuantity) {
      break;
    }

    if (accumulatedQuantity + order.executedQuantity > maxQuantity) {
      continue;
    }

    result.push(order);
    accumulatedQuantity += order.executedQuantity;
  }

  return result;
}

/**
 * 应用单个卖出订单的过滤
 * 1. 获取成交时间 < 卖出时间的买入订单
 * 2. 卖出数量 >= 买入总量：视为全部卖出
 * 3. 否则按价格过滤：保留成交价 >= 卖出价的订单
 * 4. 合并时间间隔内的订单作为下一轮输入
 */
function applySingleSellOrderFilter(
  currentBuyOrders: OrderRecord[],
  candidateOrders: ReadonlyArray<OrderRecord>,
  sellOrder: OrderRecord,
  nextSellOrder: OrderRecord | null,
  latestSellTime: number,
): OrderRecord[] {
  const sellTime = sellOrder.executedTime;
  const sellPrice = sellOrder.executedPrice;
  const sellQuantity = sellOrder.executedQuantity;

  const nextSellTime = nextSellOrder
    ? nextSellOrder.executedTime
    : latestSellTime + 1;

  const buyOrdersBeforeSell = currentBuyOrders.filter(
    (buyOrder) => buyOrder.executedTime < sellTime,
  );

  const totalBuyQuantity = calculateTotalQuantity(buyOrdersBeforeSell);

  const buyOrdersBetweenSells = candidateOrders.filter(
    (buyOrder) =>
      buyOrder.executedTime > sellTime &&
      buyOrder.executedTime < nextSellTime,
  );

  if (sellQuantity >= totalBuyQuantity || buyOrdersBeforeSell.length === 0) {
    return [...buyOrdersBetweenSells];
  }

  const maxRetainQuantity = totalBuyQuantity - sellQuantity;

  let filteredBuyOrders = buyOrdersBeforeSell.filter(
    (buyOrder) => buyOrder.executedPrice >= sellPrice,
  );

  filteredBuyOrders = adjustOrdersByQuantityLimit(
    filteredBuyOrders,
    maxRetainQuantity,
  );

  return [...filteredBuyOrders, ...buyOrdersBetweenSells];
}

/**
 * 依次应用每个卖出订单的过滤（从旧到新累积）
 * 每轮基于上一轮结果过滤，时间间隔订单从原始候选获取
 */
function applySequentialFiltering(
  state: FilteringState,
  sortedSellOrders: OrderRecord[],
): OrderRecord[] {
  const firstSellTime = sortedSellOrders[0]?.executedTime ?? 0;
  const latestSellTime = sortedSellOrders.at(-1)?.executedTime ?? 0;

  let currentBuyOrders = state.candidateOrders.filter(
    (buyOrder) => buyOrder.executedTime < firstSellTime,
  );

  for (let i = 0; i < sortedSellOrders.length; i++) {
    const sellOrder = sortedSellOrders[i];
    if (sellOrder) {
      currentBuyOrders = applySingleSellOrderFilter(
        currentBuyOrders,
        state.candidateOrders,
        sellOrder,
        sortedSellOrders[i + 1] ?? null,
        latestSellTime,
      );
    }
  }

  return currentBuyOrders;
}

/**
 * 应用订单过滤算法（主入口）
 * 按时间顺序处理卖出订单，返回当前仍持有的买入订单
 */
function applyFilteringAlgorithm(
  allBuyOrders: OrderRecord[],
  filledSellOrders: OrderRecord[],
): OrderRecord[] {
  const sortedSellOrders = [...filledSellOrders].sort(
    (a, b) => a.executedTime - b.executedTime,
  );

  if (sortedSellOrders.length === 0) {
    return allBuyOrders;
  }

  const state = initializeFilteringState(allBuyOrders, sortedSellOrders);

  if (!state) {
    return allBuyOrders;
  }

  const filteredOrders = applySequentialFiltering(state, sortedSellOrders);

  return [...state.m0Orders, ...filteredOrders];
}

/** 创建订单过滤引擎 */
export function createOrderFilteringEngine(
  _deps: OrderFilteringEngineDeps = {},
): OrderFilteringEngine {
  return {
    applyFilteringAlgorithm,
  };
}

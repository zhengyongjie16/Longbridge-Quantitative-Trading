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
 *    - 否则使用'低价优先整笔消除'策略扣减 D1 数量
 *    - M1 = 扣减结果 + 成交时间在 (D1, D2) 之间的买入订单（从原始候选订单获取）
 * 3. 对 D2 使用 M1 重复上述过程，得到 M2，以此类推
 * 4. 最终记录 = M0 + MN
 *
 * 关键约束：
 * - 必须按时间顺序从旧到新处理卖出订单
 * - 每轮过滤基于上一轮的结果（累积过滤）
 * - 时间间隔订单必须从原始候选订单获取，而非上一轮结果
 * - 使用'低价优先整笔消除'策略,不拆分订单
 */
import type { OrderRecord } from '../../types/services.js';
import type { FilteringState, OrderFilteringEngine, OrderFilteringEngineDeps } from './types.js';
import { calculateTotalQuantity } from './utils.js';
import { deductSellQuantityFromBuyOrders } from './sellDeductionPolicy.js';

/**
 * 初始化过滤状态：拆出 M0（最新卖出时间之后成交的买入订单）与待过滤候选订单。
 *
 * @param allBuyOrders 全部买入订单记录
 * @param sortedSellOrders 已按成交时间升序排列的卖出订单
 * @returns 含 m0Orders 与 candidateOrders 的 FilteringState；无卖出订单时返回 null
 */
function initializeFilteringState(
  allBuyOrders: ReadonlyArray<OrderRecord>,
  sortedSellOrders: ReadonlyArray<OrderRecord>,
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
 * 应用单个卖出订单的过滤
 * 1. 获取成交时间 < 卖出时间的买入订单
 * 2. 卖出数量 >= 买入总量：视为全部卖出
 * 3. 否则使用'低价优先整笔消除'策略扣减卖出数量
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
  const sellQuantity = sellOrder.executedQuantity;

  const nextSellTime = nextSellOrder ? nextSellOrder.executedTime : latestSellTime + 1;

  const buyOrdersBeforeSell = currentBuyOrders.filter(
    (buyOrder) => buyOrder.executedTime < sellTime,
  );

  const totalBuyQuantity = calculateTotalQuantity(buyOrdersBeforeSell);

  const buyOrdersBetweenSells = candidateOrders.filter(
    (buyOrder) => buyOrder.executedTime > sellTime && buyOrder.executedTime < nextSellTime,
  );

  if (sellQuantity >= totalBuyQuantity || buyOrdersBeforeSell.length === 0) {
    return [...buyOrdersBetweenSells];
  }

  const filteredBuyOrders = deductSellQuantityFromBuyOrders(buyOrdersBeforeSell, sellQuantity);

  return [...filteredBuyOrders, ...buyOrdersBetweenSells];
}

/**
 * 依次应用每个卖出订单的过滤（从旧到新累积）
 * 每轮基于上一轮结果过滤，时间间隔订单从原始候选获取
 */
function applySequentialFiltering(
  state: FilteringState,
  sortedSellOrders: ReadonlyArray<OrderRecord>,
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
  allBuyOrders: ReadonlyArray<OrderRecord>,
  filledSellOrders: ReadonlyArray<OrderRecord>,
): ReadonlyArray<OrderRecord> {
  const sortedSellOrders = [...filledSellOrders].sort((a, b) => a.executedTime - b.executedTime);

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

/**
 * 创建订单过滤引擎（无状态，封装智能清仓决策算法）
 * @param _deps 可选依赖，当前未使用
 * @returns OrderFilteringEngine 接口实例（applyFilteringAlgorithm）
 */
export function createOrderFilteringEngine(
  _deps: OrderFilteringEngineDeps = {},
): OrderFilteringEngine {
  return {
    applyFilteringAlgorithm,
  };
}

/**
 * 卖出扣减策略模块
 *
 * 职责：
 * - 实现统一的"低价优先整笔消除"策略
 * - 用于订单过滤引擎、本地更新、智能平仓选单
 * - 确保四条链路(启动重建、运行时更新、智能平仓、风控)口径一致
 *
 * 核心原则：
 * - 纯函数,无副作用
 * - 稳定排序,可复现
 * - 整笔语义,不拆分订单
 * - 价格解耦,卖出成交价不参与判定
 */
import { logger } from '../../utils/logger/index.js';
import type { OrderRecord } from '../../types/services.js';

/**
 * 从买入订单列表中扣减卖出数量
 *
 * 算法逻辑：
 * 1. 按 executedPrice asc → executedTime asc → orderId asc 稳定排序
 * 2. 从低到高遍历,订单数量 <= 剩余扣减量则消除,否则整笔保留
 * 3. 返回剩余订单列表
 *
 * @param candidateBuyOrders 候选买入订单列表
 * @param sellQuantity 卖出数量
 * @returns 扣减后剩余的买入订单列表
 */
export function deductSellQuantityFromBuyOrders(
  candidateBuyOrders: ReadonlyArray<OrderRecord>,
  sellQuantity: number,
): OrderRecord[] {
  // 边界情况1: 空列表直接返回空数组
  if (candidateBuyOrders.length === 0) {
    return [];
  }

  // 边界情况2: 卖出数量 <= 0,返回原列表副本
  if (sellQuantity <= 0) {
    if (sellQuantity < 0) {
      logger.warn(`[卖出扣减策略] 卖出数量为负数: ${sellQuantity},返回原列表`);
    }
    return [...candidateBuyOrders];
  }

  // 边界情况3: 卖出数量非有限数,返回原列表副本
  if (!Number.isFinite(sellQuantity)) {
    logger.warn(`[卖出扣减策略] 卖出数量非有限数: ${sellQuantity},返回原列表`);
    return [...candidateBuyOrders];
  }

  // 稳定排序: executedPrice asc → executedTime asc → orderId asc
  const sortedOrders = [...candidateBuyOrders].sort((a, b) => {
    // 第一级: 价格从低到高
    if (a.executedPrice !== b.executedPrice) {
      return a.executedPrice - b.executedPrice;
    }

    // 第二级: 时间从早到晚
    if (a.executedTime !== b.executedTime) {
      return a.executedTime - b.executedTime;
    }

    // 第三级: orderId 字典序
    return a.orderId.localeCompare(b.orderId);
  });

  // 整笔扣减: 从低到高遍历,订单数量 <= 剩余扣减量则消除,否则整笔保留
  const remainingOrders: OrderRecord[] = [];
  let remainingDeduction = sellQuantity;

  for (const order of sortedOrders) {
    if (remainingDeduction <= 0) {
      // 扣减量已用完,保留剩余所有订单
      remainingOrders.push(order);
      continue;
    }

    if (order.executedQuantity <= remainingDeduction) {
      // 订单数量 <= 剩余扣减量,消除该订单
      remainingDeduction -= order.executedQuantity;
    } else {
      // 订单数量 > 剩余扣减量,整笔保留(不拆分)
      remainingOrders.push(order);
    }
  }

  return remainingOrders;
}

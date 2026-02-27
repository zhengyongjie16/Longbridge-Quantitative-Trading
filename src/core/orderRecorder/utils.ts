import { OrderSide, OrderStatus } from 'longport';
import { PENDING_ORDER_STATUSES, TIME } from '../../constants/index.js';
import { decimalToNumber } from '../../utils/helpers/index.js';
import { calculateTradingDurationMsBetween } from '../../utils/helpers/tradingTime.js';
import {
  decimalAdd,
  decimalDiv,
  decimalGt,
  decimalMul,
  decimalToNumberValue,
  toDecimalValue,
} from '../../utils/numeric/index.js';
import type { OrderRecord, RawOrderFromAPI } from '../../types/services.js';
import type { OrderTimeoutCheckParams } from '../../types/tradingCalendar.js';
import type { OrderRebuildClassification, OrderStatistics } from './types.js';

/**
 * 计算订单列表的统计信息（用于调试输出与成本均价计算）。
 * 默认行为：价格或数量无效的订单按 0 参与累加；无订单时均价为 0。
 *
 * @param orders 订单记录列表
 * @returns 包含总数量、总价值、均价的统计对象
 */
export function calculateOrderStatistics(orders: ReadonlyArray<OrderRecord>): OrderStatistics {
  let totalQuantity = toDecimalValue(0);
  let totalValue = toDecimalValue(0);

  for (const order of orders) {
    const quantity = Number.isFinite(order.executedQuantity) ? order.executedQuantity : 0;
    const price = Number.isFinite(order.executedPrice) ? order.executedPrice : 0;
    totalQuantity = decimalAdd(totalQuantity, quantity);
    totalValue = decimalAdd(totalValue, decimalMul(price, quantity));
  }

  const averagePrice = decimalGt(totalQuantity, 0)
    ? decimalToNumberValue(decimalDiv(totalValue, totalQuantity))
    : 0;
  return {
    totalQuantity: decimalToNumberValue(totalQuantity),
    totalValue: decimalToNumberValue(totalValue),
    averagePrice,
  };
}

/**
 * 计算订单列表的总成交数量。
 * 默认行为：单笔订单的 executedQuantity 非有限数时视为 0 参与累加。
 *
 * @param orders 订单记录列表
 * @returns 所有订单的成交数量之和，无效数量视为 0
 */
export function calculateTotalQuantity(orders: ReadonlyArray<OrderRecord>): number {
  let total = toDecimalValue(0);
  for (const order of orders) {
    const quantity = Number.isFinite(order.executedQuantity) ? order.executedQuantity : 0;
    total = decimalAdd(total, quantity);
  }
  return decimalToNumberValue(total);
}

/**
 * 按严格交易时段累计口径判定订单是否超时。
 * 触发条件：heldTradingMs > timeoutMinutes * 60_000（严格大于）。
 *
 * @param params 订单成交时间、当前时间、超时分钟与交易日历快照
 * @returns true 表示超时；false 表示未超时或参数无效
 */
export function isOrderTimedOut(params: OrderTimeoutCheckParams): boolean {
  const { orderExecutedTimeMs, nowMs, timeoutMinutes, calendarSnapshot } = params;
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 0) {
    return false;
  }

  const timeoutMs = timeoutMinutes * TIME.MILLISECONDS_PER_MINUTE;
  const heldTradingMs = calculateTradingDurationMsBetween({
    startMs: orderExecutedTimeMs,
    endMs: nowMs,
    calendarSnapshot,
  });
  return heldTradingMs > timeoutMs;
}

/**
 * 将原始 API 订单转换为内部 OrderRecord 格式（内部辅助函数）
 *
 * 转换逻辑：
 * - 提取成交价格、成交数量和成交时间
 * - 买入订单保留 submittedAt 和 updatedAt 字段（用于成本计算）
 * - 卖出订单不保留时间字段（仅需成交信息）
 * - 价格/数量/时间任一无效时返回 null
 *
 * @param order 原始 API 订单数据
 * @param isBuyOrder 是否为买入订单（影响 submittedAt/updatedAt 是否保留）
 * @returns 转换后的订单记录，价格/数量/时间无效时返回 null
 */
function convertOrderToRecord(order: RawOrderFromAPI, isBuyOrder: boolean): OrderRecord | null {
  const executedPrice = decimalToNumber(order.executedPrice);
  const executedQuantity = decimalToNumber(order.executedQuantity);
  const executedTime = order.updatedAt ? order.updatedAt.getTime() : 0;

  if (
    !Number.isFinite(executedPrice) ||
    executedPrice <= 0 ||
    !Number.isFinite(executedQuantity) ||
    executedQuantity <= 0 ||
    executedTime === 0
  ) {
    return null;
  }

  return {
    orderId: order.orderId,
    symbol: order.symbol,
    executedPrice,
    executedQuantity,
    executedTime,
    submittedAt: isBuyOrder ? (order.submittedAt ?? undefined) : undefined,
    updatedAt: isBuyOrder ? (order.updatedAt ?? undefined) : undefined,
  };
}

/**
 * 将原始 API 订单列表按买卖方向分类并转换为内部 OrderRecord 格式。
 * 默认行为：仅处理 status 为 Filled 的订单，价格/数量/时间无效的订单被跳过。
 *
 * @param orders 原始 API 订单列表
 * @returns 分类后的买入订单列表与卖出订单列表（仅包含已成交且转换成功的订单）
 */
export function classifyAndConvertOrders(orders: ReadonlyArray<RawOrderFromAPI>): {
  buyOrders: ReadonlyArray<OrderRecord>;
  sellOrders: ReadonlyArray<OrderRecord>;
} {
  const buyOrders: OrderRecord[] = [];
  const sellOrders: OrderRecord[] = [];

  for (const order of orders) {
    if (order.status !== OrderStatus.Filled) {
      continue;
    }

    const isBuyOrder = order.side === OrderSide.Buy;
    const isSellOrder = order.side === OrderSide.Sell;

    if (!isBuyOrder && !isSellOrder) {
      continue;
    }

    const converted = convertOrderToRecord(order, isBuyOrder);
    if (!converted) {
      continue;
    }

    if (isBuyOrder) {
      buyOrders.push(converted);
    } else {
      sellOrders.push(converted);
    }
  }

  return { buyOrders, sellOrders };
}

/**
 * 启动/重建阶段对单标的全量订单做统一分类与分流。
 * 默认行为：
 * - Filled 订单会转换为 OrderRecord 参与重建（无效价格/数量/时间会被跳过）
 * - Pending 订单保留原始结构，交由恢复阶段继续跟踪或撤单
 * - 其他关闭状态（Canceled/Rejected 等）直接忽略
 *
 * @param orders 单标的全量订单
 * @returns Filled/Pending 按买卖方向分流后的分类结果
 */
export function classifyOrdersForRebuild(
  orders: ReadonlyArray<RawOrderFromAPI>,
): OrderRebuildClassification {
  const filledBuyOrders: OrderRecord[] = [];
  const filledSellOrders: OrderRecord[] = [];
  const pendingBuyOrders: RawOrderFromAPI[] = [];
  const pendingSellOrders: RawOrderFromAPI[] = [];

  for (const order of orders) {
    if (order.status === OrderStatus.Filled) {
      const isBuyOrder = order.side === OrderSide.Buy;
      const isSellOrder = order.side === OrderSide.Sell;
      if (!isBuyOrder && !isSellOrder) {
        continue;
      }
      const converted = convertOrderToRecord(order, isBuyOrder);
      if (!converted) {
        continue;
      }
      if (isBuyOrder) {
        filledBuyOrders.push(converted);
      } else {
        filledSellOrders.push(converted);
      }
      continue;
    }

    if (!PENDING_ORDER_STATUSES.has(order.status)) {
      continue;
    }

    if (order.side === OrderSide.Buy) {
      pendingBuyOrders.push(order);
      continue;
    }
    if (order.side === OrderSide.Sell) {
      pendingSellOrders.push(order);
    }
  }

  return {
    filledBuyOrders,
    filledSellOrders,
    pendingBuyOrders,
    pendingSellOrders,
  };
}

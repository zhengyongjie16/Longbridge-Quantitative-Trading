/**
 * 风险模块通用工具：计算当日亏损偏移。
 */
import { OrderStatus } from 'longport';
import type { OrderRecord, RawOrderFromAPI } from '../../types/index.js';
import type { DailyLossCalculatorParams, DailyLossOffsetMap } from './types.js';

/**
 * 生成北京时间日键（YYYY/MM/DD），用于筛选当日订单。
 */
export function resolveBeijingDayKey(
  toBeijingTimeIso: (date: Date | null) => string,
  date: Date,
): string | null {
  if (!Number.isFinite(date.getTime())) {
    return null;
  }
  const iso = toBeijingTimeIso(date);
  const parts = iso.split('/');
  if (parts.length < 3) {
    return null;
  }
  return `${parts[0]}/${parts[1]}/${parts[2]}`;
}

/**
 * 汇总订单成本：成交价 * 成交量。
 */
export function sumOrderCost(orders: ReadonlyArray<OrderRecord>): number {
  let total = 0;
  for (const order of orders) {
    const price = Number(order.executedPrice);
    const quantity = Number(order.executedQuantity);
    if (
      Number.isFinite(price) &&
      price > 0 &&
      Number.isFinite(quantity) &&
      quantity > 0
    ) {
      total += price * quantity;
    }
  }
  return total;
}

/**
 * 计算订单列表的当日亏损偏移（totalBuy - totalSell - openBuyCost）。
 */
function calculateLossOffsetForOrders(
  orders: ReadonlyArray<RawOrderFromAPI>,
  deps: Pick<DailyLossCalculatorParams, 'filteringEngine' | 'classifyAndConvertOrders'>,
): number {
  if (orders.length === 0) {
    return 0;
  }
  const { buyOrders, sellOrders } = deps.classifyAndConvertOrders(orders);
  if (buyOrders.length === 0 && sellOrders.length === 0) {
    return 0;
  }
  const totalBuy = sumOrderCost(buyOrders);
  const totalSell = sumOrderCost(sellOrders);
  const openBuyOrders = deps.filteringEngine.applyFilteringAlgorithm(
    [...buyOrders],
    [...sellOrders],
  );
  const openBuyCost = sumOrderCost(openBuyOrders);
  return totalBuy - totalSell - openBuyCost;
}

/**
 * 批量计算所有监控标的的当日亏损偏移。
 */
export function calculateDailyLossOffsetForOrders({
  orders,
  monitors,
  now,
  filteringEngine,
  resolveOrderOwnership,
  classifyAndConvertOrders,
  toBeijingTimeIso,
}: DailyLossCalculatorParams): DailyLossOffsetMap {
  const result = new Map<string, { long: number; short: number }>();
  for (const monitor of monitors) {
    if (!result.has(monitor.monitorSymbol)) {
      result.set(monitor.monitorSymbol, { long: 0, short: 0 });
    }
  }

  const todayKey = resolveBeijingDayKey(toBeijingTimeIso, now);
  if (!todayKey) {
    return result;
  }

  const grouped = new Map<string, { long: RawOrderFromAPI[]; short: RawOrderFromAPI[] }>();

  for (const order of orders) {
    if (order.status !== OrderStatus.Filled) {
      continue;
    }
    if (!(order.updatedAt instanceof Date)) {
      continue;
    }
    const orderDayKey = resolveBeijingDayKey(toBeijingTimeIso, order.updatedAt);
    if (!orderDayKey || orderDayKey !== todayKey) {
      continue;
    }
    const ownership = resolveOrderOwnership(order, monitors);
    if (!ownership) {
      continue;
    }
    const existing = grouped.get(ownership.monitorSymbol) ?? {
      long: [],
      short: [],
    };
    if (ownership.direction === 'LONG') {
      existing.long.push(order);
    } else {
      existing.short.push(order);
    }
    grouped.set(ownership.monitorSymbol, existing);
  }

  for (const [monitorSymbol, group] of grouped) {
    const longOffset = calculateLossOffsetForOrders(group.long, {
      filteringEngine,
      classifyAndConvertOrders,
    });
    const shortOffset = calculateLossOffsetForOrders(group.short, {
      filteringEngine,
      classifyAndConvertOrders,
    });
    result.set(monitorSymbol, { long: longOffset, short: shortOffset });
  }

  return result;
}

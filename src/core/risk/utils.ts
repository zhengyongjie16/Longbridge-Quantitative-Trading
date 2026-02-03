/**
 * 风险模块通用工具：计算当日亏损偏移。
 */
import { OrderStatus } from 'longport';
import type { MonitorConfig, OrderRecord, RawOrderFromAPI } from '../../types/index.js';
import type { OrderOwnership } from '../orderRecorder/types.js';
import type { OrderOwnershipDiagnostics, OrderOwnershipDiagnosticSample } from './types.js';

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

export function collectOrderOwnershipDiagnostics({
  orders,
  monitors,
  now,
  resolveOrderOwnership,
  toBeijingTimeIso,
  maxSamples = 3,
}: {
  readonly orders: ReadonlyArray<RawOrderFromAPI>;
  readonly monitors: ReadonlyArray<Pick<MonitorConfig, 'monitorSymbol' | 'orderOwnershipMapping'>>;
  readonly now: Date;
  readonly resolveOrderOwnership: (
    order: RawOrderFromAPI,
    monitors: ReadonlyArray<Pick<MonitorConfig, 'monitorSymbol' | 'orderOwnershipMapping'>>,
  ) => OrderOwnership | null;
  readonly toBeijingTimeIso: (date: Date | null) => string;
  readonly maxSamples?: number;
}): OrderOwnershipDiagnostics | null {
  const dayKey = resolveBeijingDayKey(toBeijingTimeIso, now);
  if (!dayKey) {
    return null;
  }

  const sampleLimit = Number.isFinite(maxSamples) && maxSamples > 0
    ? Math.floor(maxSamples)
    : 0;

  let totalFilled = 0;
  let inDayFilled = 0;
  let unmatchedFilled = 0;
  const unmatchedSamples: OrderOwnershipDiagnosticSample[] = [];

  for (const order of orders) {
    if (order.status !== OrderStatus.Filled) {
      continue;
    }
    totalFilled += 1;

    if (!(order.updatedAt instanceof Date)) {
      continue;
    }
    const orderDayKey = resolveBeijingDayKey(toBeijingTimeIso, order.updatedAt);
    if (!orderDayKey || orderDayKey !== dayKey) {
      continue;
    }
    inDayFilled += 1;

    const ownership = resolveOrderOwnership(order, monitors);
    if (ownership) {
      continue;
    }
    unmatchedFilled += 1;
    if (sampleLimit > 0 && unmatchedSamples.length < sampleLimit) {
      unmatchedSamples.push({
        orderId: order.orderId,
        symbol: order.symbol,
        stockName: order.stockName,
      });
    }
  }

  return {
    dayKey,
    totalFilled,
    inDayFilled,
    unmatchedFilled,
    unmatchedSamples,
  };
}

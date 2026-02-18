import { OrderStatus } from 'longport';
import { isValidPositiveNumber } from '../../utils/helpers/index.js';
import type { MonitorConfig } from '../../types/config.js';
import type { OrderRecord, RawOrderFromAPI } from '../../types/services.js';
import type { OrderOwnership } from '../orderRecorder/types.js';
import type { OrderOwnershipDiagnostics, OrderOwnershipDiagnosticSample } from './types.js';

/**
 * 生成香港时间日键（YYYY/MM/DD），用于筛选当日订单。
 */
export function resolveHongKongDayKey(
  toHongKongTimeIso: (date: Date | null) => string,
  date: Date,
): string | null {
  if (!Number.isFinite(date.getTime())) {
    return null;
  }
  const iso = toHongKongTimeIso(date);
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
    if (isValidPositiveNumber(price) && isValidPositiveNumber(quantity)) {
      total += price * quantity;
    }
  }
  return total;
}

/**
 * 收集订单归属诊断信息，用于启动时检测当日成交订单中未能归属到任何监控标的的订单数量与样例。
 * @param orders 全量原始订单列表
 * @param monitors 监控配置列表，用于归属匹配
 * @param now 当前时间，用于确定当日日键
 * @param resolveOrderOwnership 订单归属解析函数
 * @param toHongKongTimeIso 日期转香港时间 ISO 字符串的函数
 * @param maxSamples 未归属订单最大样例数，默认 3
 * @returns 诊断结果，日键无效时返回 null
 */
export function collectOrderOwnershipDiagnostics({
  orders,
  monitors,
  now,
  resolveOrderOwnership,
  toHongKongTimeIso,
  maxSamples = 3,
}: {
  readonly orders: ReadonlyArray<RawOrderFromAPI>;
  readonly monitors: ReadonlyArray<Pick<MonitorConfig, 'monitorSymbol' | 'orderOwnershipMapping'>>;
  readonly now: Date;
  readonly resolveOrderOwnership: (
    order: RawOrderFromAPI,
    monitors: ReadonlyArray<Pick<MonitorConfig, 'monitorSymbol' | 'orderOwnershipMapping'>>,
  ) => OrderOwnership | null;
  readonly toHongKongTimeIso: (date: Date | null) => string;
  readonly maxSamples?: number;
}): OrderOwnershipDiagnostics | null {
  const dayKey = resolveHongKongDayKey(toHongKongTimeIso, now);
  if (!dayKey) {
    return null;
  }

  const sampleLimit = isValidPositiveNumber(maxSamples) ? Math.floor(maxSamples) : 0;

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
    const orderDayKey = resolveHongKongDayKey(toHongKongTimeIso, order.updatedAt);
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

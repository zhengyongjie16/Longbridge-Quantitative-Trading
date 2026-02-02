/**
 * 风险模块通用工具：计算当日亏损偏移。
 */
import type { OrderRecord } from '../../types/index.js';

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

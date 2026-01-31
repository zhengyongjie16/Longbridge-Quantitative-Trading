/**
 * 订单归属解析：
 * - 根据订单名称中的 RC/RP 与监控标的，判断订单属于多/空方向
 * - 提供订单归属解析与最近成交标的查询
 */
import { OrderStatus } from 'longport';
import type { MonitorConfig, RawOrderFromAPI } from '../../types/index.js';
import type { OrderOwnership } from './types.js';

// 监控标的统一去掉 .HK 后缀，便于和 stockName 匹配
function normalizeMonitorSymbol(monitorSymbol: string): string {
  return monitorSymbol.trim().toUpperCase().replace(/\.HK$/i, '');
}

// 订单名称统一转大写，避免大小写导致误判
function normalizeStockName(stockName: string): string {
  return stockName.trim().toUpperCase();
}

/**
 * 解析订单归属方向：
 * - stockName 需要包含监控标的代码
 * - RC 表示牛证(做多)，RP 表示熊证(做空)
 */
export function parseOrderOwnership(
  stockName: string | null | undefined,
  monitorSymbol: string,
): 'LONG' | 'SHORT' | null {
  if (!stockName) {
    return null;
  }

  const normalizedMonitorSymbol = normalizeMonitorSymbol(monitorSymbol);
  if (!normalizedMonitorSymbol) {
    return null;
  }

  const normalizedStockName = normalizeStockName(stockName);
  if (!normalizedStockName.includes(normalizedMonitorSymbol)) {
    return null;
  }

  const hasRC = normalizedStockName.includes('RC');
  const hasRP = normalizedStockName.includes('RP');

  if (hasRC && !hasRP) {
    return 'LONG';
  }
  if (hasRP && !hasRC) {
    return 'SHORT';
  }

  return null;
}

/**
 * 在多监控标的场景下解析订单归属。
 * 若无法匹配任意监控标的，返回 null。
 */
export function resolveOrderOwnership(
  order: RawOrderFromAPI,
  monitors: ReadonlyArray<Pick<MonitorConfig, 'monitorSymbol'>>,
): OrderOwnership | null {
  for (const monitor of monitors) {
    const direction = parseOrderOwnership(order.stockName, monitor.monitorSymbol);
    if (direction) {
      return {
        monitorSymbol: monitor.monitorSymbol,
        direction,
      };
    }
  }

  return null;
}

/**
 * 获取指定监控标的与方向下最新成交的交易标的。
 */
export function getLatestTradedSymbol(
  orders: ReadonlyArray<RawOrderFromAPI>,
  monitorSymbol: string,
  direction: 'LONG' | 'SHORT',
): string | null {
  let latestSymbol: string | null = null;
  let latestTime = 0;

  for (const order of orders) {
    if (order.status !== OrderStatus.Filled) {
      continue;
    }

    const orderDirection = parseOrderOwnership(order.stockName, monitorSymbol);
    if (orderDirection !== direction) {
      continue;
    }

    // updatedAt 代表成交后更新时间，取最大值作为最近成交
    const resolvedTime = order.updatedAt ? order.updatedAt.getTime() : 0;
    if (resolvedTime <= latestTime) {
      continue;
    }

    latestTime = resolvedTime;
    latestSymbol = order.symbol;
  }

  return latestSymbol;
}

/**
 * 订单归属解析：
 * - 根据订单名称中的 RC/RP 与归属缩写映射，判断订单属于多/空方向
 * - 提供订单归属解析与最近成交标的查询
 */
import { OrderStatus } from 'longport';
import type { MonitorConfig, RawOrderFromAPI } from '../../types/index.js';
import type { OrderOwnership } from './types.js';

// 订单名称统一转大写，避免大小写导致误判
function normalizeStockName(stockName: string): string {
  return stockName.trim().toUpperCase();
}

// 归属缩写统一转大写，避免大小写导致误判
function normalizeOwnershipAlias(alias: string): string {
  return alias.trim().toUpperCase();
}

/**
 * 解析订单归属方向：
 * - stockName 需包含归属缩写（来自配置映射）
 * - RC 表示牛证(做多)，RP 表示熊证(做空)
 */
export function parseOrderOwnership(
  stockName: string | null | undefined,
  orderOwnershipMapping: ReadonlyArray<string>,
): 'LONG' | 'SHORT' | null {
  if (!stockName) {
    return null;
  }

  if (!orderOwnershipMapping || orderOwnershipMapping.length === 0) {
    return null;
  }

  const normalizedStockName = normalizeStockName(stockName);
  for (const alias of orderOwnershipMapping) {
    const normalizedAlias = normalizeOwnershipAlias(alias);
    if (!normalizedAlias) {
      continue;
    }
    const hasRC = normalizedStockName.includes(`${normalizedAlias}RC`);
    const hasRP = normalizedStockName.includes(`${normalizedAlias}RP`);
    if (hasRC && !hasRP) {
      return 'LONG';
    }
    if (hasRP && !hasRC) {
      return 'SHORT';
    }
  }

  return null;
}

/**
 * 在多监控标的场景下解析订单归属。
 * 若无法匹配任意监控标的，返回 null。
 */
export function resolveOrderOwnership(
  order: RawOrderFromAPI,
  monitors: ReadonlyArray<Pick<MonitorConfig, 'monitorSymbol' | 'orderOwnershipMapping'>>,
): OrderOwnership | null {
  for (const monitor of monitors) {
    const direction = parseOrderOwnership(order.stockName, monitor.orderOwnershipMapping);
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
  orderOwnershipMapping: ReadonlyArray<string>,
  direction: 'LONG' | 'SHORT',
): string | null {
  let latestSymbol: string | null = null;
  let latestTime = 0;

  for (const order of orders) {
    if (order.status !== OrderStatus.Filled) {
      continue;
    }

    const orderDirection = parseOrderOwnership(order.stockName, orderOwnershipMapping);
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

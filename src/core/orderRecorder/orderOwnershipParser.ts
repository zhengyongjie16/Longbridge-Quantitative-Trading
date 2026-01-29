import { OrderStatus } from 'longport';
import type { MonitorConfig, RawOrderFromAPI } from '../../types/index.js';
import type { OrderOwnership } from './types.js';

function normalizeMonitorSymbol(monitorSymbol: string): string {
  return monitorSymbol.trim().toUpperCase().replace(/\.HK$/i, '');
}

function normalizeStockName(stockName: string): string {
  return stockName.trim().toUpperCase();
}

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

    const resolvedTime = order.updatedAt ? order.updatedAt.getTime() : 0;
    if (resolvedTime <= latestTime) {
      continue;
    }

    latestTime = resolvedTime;
    latestSymbol = order.symbol;
  }

  return latestSymbol;
}

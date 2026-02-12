/**
 * 订单归属解析：
 * - 根据订单名称中的 RC/RP 与归属缩写映射，判断订单属于多/空方向
 * - 提供订单归属解析与最近成交标的查询
 */
import { OrderStatus } from 'longport';
import type { MonitorConfig, RawOrderFromAPI } from '../../types/index.js';
import type { OrderOwnership } from './types.js';

const NORMALIZE_PATTERN = /[^\p{L}\p{N}]/gu;
const LONG_MARKERS = ['RC', 'BULL', 'CALL', '\u725b'];
const SHORT_MARKERS = ['RP', 'BEAR', 'PUT', '\u718a'];

/** 统一转大写并去除非字母数字字符，避免大小写与分隔符导致误判 */
function normalizeForMatching(str: string): string {
  return str.trim().toUpperCase().replaceAll(NORMALIZE_PATTERN, '');
}

function resolveDirectionFromNormalizedName(
  normalizedStockName: string,
): 'LONG' | 'SHORT' | null {
  const hasLongMarker = LONG_MARKERS.some((m) => normalizedStockName.includes(m));
  const hasShortMarker = SHORT_MARKERS.some((m) => normalizedStockName.includes(m));
  if (hasLongMarker && !hasShortMarker) {
    return 'LONG';
  }
  if (hasShortMarker && !hasLongMarker) {
    return 'SHORT';
  }
  return null;
}

/**
 * 解析订单归属方向
 * stockName 需同时满足：1) 包含 RC(牛证/做多) 或 RP(熊证/做空)；2) 包含配置映射中的归属缩写
 */
function parseOrderOwnership(
  stockName: string | null | undefined,
  orderOwnershipMapping: ReadonlyArray<string>,
): 'LONG' | 'SHORT' | null {
  if (!stockName) {
    return null;
  }

  if (!orderOwnershipMapping || orderOwnershipMapping.length === 0) {
    return null;
  }

  const normalizedStockName = normalizeForMatching(stockName);
  const direction = resolveDirectionFromNormalizedName(normalizedStockName);
  if (!direction) {
    return null;
  }

  for (const alias of orderOwnershipMapping) {
    const normalizedAlias = normalizeForMatching(alias);
    if (!normalizedAlias) {
      continue;
    }
    if (normalizedStockName.includes(normalizedAlias)) {
      return direction;
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

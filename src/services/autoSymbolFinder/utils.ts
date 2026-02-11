/**
 * 自动寻标工具：过滤候选与筛选最佳牛熊证。
 */
import { FilterWarrantExpiryDate, WarrantStatus } from 'longport';
import { decimalToNumber } from '../../utils/helpers/index.js';
import type {
  SelectBestWarrantInput,
  WarrantCandidate,
  WarrantListCache,
  WarrantListCacheEntry,
  WarrantListItem,
} from './types.js';

/** 检查牛熊证状态是否为正常 */
function isNormalStatus(status: WarrantListItem['status']): boolean {
  return status === WarrantStatus.Normal;
}

const EXPIRY_DATE_FILTERS: ReadonlyArray<FilterWarrantExpiryDate> = [
  FilterWarrantExpiryDate.Between_3_6,
  FilterWarrantExpiryDate.Between_6_12,
  FilterWarrantExpiryDate.GT_12,
];

/**
 * 创建牛熊证列表缓存实例
 * 用于避免频繁调用 API，支持 TTL 缓存和请求去重
 */
export function createWarrantListCache(): WarrantListCache {
  const entries = new Map<string, WarrantListCacheEntry>();
  const inFlight = new Map<string, Promise<ReadonlyArray<WarrantListItem>>>();

  return {
    entries,
    inFlight,
    clear(): void {
      entries.clear();
      inFlight.clear();
    },
  };
}

/**
 * 根据最小到期月数生成筛选条件，避免临近到期标的。
 */
export function buildExpiryDateFilters(
  expiryMinMonths: number,
): ReadonlyArray<FilterWarrantExpiryDate> {
  if (!Number.isFinite(expiryMinMonths) || expiryMinMonths <= 3) {
    return EXPIRY_DATE_FILTERS;
  }
  if (expiryMinMonths <= 6) {
    return EXPIRY_DATE_FILTERS.slice(1);
  }
  return EXPIRY_DATE_FILTERS.slice(2);
}

/**
 * 选取最佳标的：
 * - 基于 toCallPrice 距回收价百分比筛选
 *   - 牛证：distancePct > minDistancePct（正值，距回收价足够远）
 *   - 熊证：distancePct < minDistancePct（负值，距回收价足够远）
 * - 选优：|distancePct| 更小优先（距回收价更近，杠杆更大）
 * - |distancePct| 相同则按分均成交额更高优先
 */
export function selectBestWarrant({
  warrants,
  tradingMinutes,
  isBull,
  minDistancePct,
  minTurnoverPerMinute,
}: SelectBestWarrantInput): WarrantCandidate | null {
  const hasTradingMinutes = tradingMinutes > 0;
  const minTurnover = hasTradingMinutes ? minTurnoverPerMinute * tradingMinutes : 0;
  const shouldFilterTurnover = hasTradingMinutes || minTurnoverPerMinute > 0;

  let bestSymbol: string | null = null;
  let bestName: string | null = null;
  let bestCallPrice = 0;
  let bestDistancePct = 0;
  let bestTurnover = 0;
  let bestTurnoverPerMinute = 0;

  for (const warrant of warrants) {
    if (!warrant?.symbol) {
      continue;
    }
    if (!isNormalStatus(warrant.status)) {
      continue;
    }

    const callPriceNum = decimalToNumber(warrant.callPrice);
    if (
      callPriceNum == null ||
      !Number.isFinite(callPriceNum) ||
      callPriceNum <= 0
    ) {
      continue;
    }

    const distancePct = decimalToNumber(warrant.toCallPrice);
    if (!Number.isFinite(distancePct)) {
      continue;
    }

    const passesDistanceFilter = isBull
      ? distancePct > minDistancePct
      : distancePct < minDistancePct;
    if (!passesDistanceFilter) {
      continue;
    }

    const turnover = decimalToNumber(warrant.turnover);
    if (!Number.isFinite(turnover) || turnover <= 0) {
      continue;
    }

    if (shouldFilterTurnover) {
      if (!hasTradingMinutes) {
        continue;
      }
      if (turnover < minTurnover) {
        continue;
      }
    }

    const turnoverPerMinute = hasTradingMinutes ? turnover / tradingMinutes : 0;
    if (turnoverPerMinute < minTurnoverPerMinute) {
      continue;
    }

    const absDistance = Math.abs(distancePct);
    const bestAbsDistance = Math.abs(bestDistancePct);
    if (
      bestSymbol === null ||
      absDistance < bestAbsDistance ||
      (absDistance === bestAbsDistance && turnoverPerMinute > bestTurnoverPerMinute)
    ) {
      bestSymbol = warrant.symbol;
      bestName = warrant.name ?? null;
      bestCallPrice = callPriceNum;
      bestDistancePct = distancePct;
      bestTurnover = turnover;
      bestTurnoverPerMinute = turnoverPerMinute;
    }
  }

  if (!bestSymbol) {
    return null;
  }

  return {
    symbol: bestSymbol,
    name: bestName ?? null,
    callPrice: bestCallPrice,
    distancePct: bestDistancePct,
    turnover: bestTurnover,
    turnoverPerMinute: bestTurnoverPerMinute,
  };
}

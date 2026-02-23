import { FilterWarrantExpiryDate, WarrantStatus } from 'longport';
import { decimalToNumber } from '../../utils/helpers/index.js';
import type {
  SelectBestWarrantInput,
  WarrantCandidate,
  WarrantListCache,
  WarrantListCacheEntry,
  WarrantListItem,
} from './types.js';

/**
 * 检查牛熊证状态是否为正常（内部辅助函数）
 * @param status 牛熊证状态枚举值
 * @returns true 表示状态为 Normal，可以交易
 */
function isNormalStatus(status: WarrantListItem['status']): boolean {
  return status === WarrantStatus.Normal;
}

const EXPIRY_DATE_FILTERS: ReadonlyArray<FilterWarrantExpiryDate> = [
  FilterWarrantExpiryDate.Between_3_6,
  FilterWarrantExpiryDate.Between_6_12,
  FilterWarrantExpiryDate.GT_12,
];

/**
 * 创建牛熊证列表缓存实例，用于避免频繁调用 API，支持 TTL 缓存和请求去重。
 * @returns 实现了 WarrantListCache 接口的缓存对象
 */
export function createWarrantListCache(): WarrantListCache {
  const entries = new Map<string, WarrantListCacheEntry>();
  const inFlight = new Map<string, Promise<ReadonlyArray<WarrantListItem>>>();

  return {
    getEntry(key: string): WarrantListCacheEntry | undefined {
      return entries.get(key);
    },
    setEntry(key: string, entry: WarrantListCacheEntry): void {
      entries.set(key, entry);
    },
    getInFlight(key: string): Promise<ReadonlyArray<WarrantListItem>> | undefined {
      return inFlight.get(key);
    },
    setInFlight(key: string, request: Promise<ReadonlyArray<WarrantListItem>>): void {
      inFlight.set(key, request);
    },
    deleteInFlight(key: string): void {
      inFlight.delete(key);
    },
    clear(): void {
      entries.clear();
      inFlight.clear();
    },
  };
}

/**
 * 根据最小到期月数生成到期日筛选条件，避免选入临近到期标的。
 * @param expiryMinMonths 最小到期月数
 * @returns 对应的到期日筛选条件数组
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
 * 从候选列表中选取最佳牛熊证标的。
 * - 牛证：distancePct > minDistancePct（正值，距回收价足够远）
 * - 熊证：distancePct < minDistancePct（负值，距回收价足够远）
 * - 选优：|distancePct| 更小优先（距回收价更近，杠杆更大）；相同时按分均成交额更高优先
 * @param warrants 候选牛熊证列表
 * @param tradingMinutes 当日已交易分钟数，用于计算分均成交额
 * @param isBull 是否为牛证
 * @param minDistancePct 距回收价最小百分比阈值
 * @param minTurnoverPerMinute 最低分均成交额要求
 * @returns 最佳候选标的，无符合条件时返回 null
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
    if (!Number.isFinite(callPriceNum) || callPriceNum <= 0) {
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

    if (shouldFilterTurnover && (!hasTradingMinutes || turnover < minTurnover)) {
      continue;
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

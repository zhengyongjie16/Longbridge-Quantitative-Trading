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

// 统一兼容不同枚举值的「正常」状态
function isNormalStatus(status: WarrantListItem['status']): boolean {
  return status === WarrantStatus.Normal || status === 'Normal' || status === 2;
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
  return {
    entries: new Map<string, WarrantListCacheEntry>(),
    inFlight: new Map<string, Promise<ReadonlyArray<WarrantListItem>>>(),
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
 * - 价格优先（更低价格更易成交）
 * - 价格相同则按单位时间成交额更高优先
 */
export function selectBestWarrant({
  warrants,
  tradingMinutes,
  minPrice,
  minTurnoverPerMinute,
}: SelectBestWarrantInput): WarrantCandidate | null {
  const hasTradingMinutes = tradingMinutes > 0;
  const minTurnover = hasTradingMinutes ? minTurnoverPerMinute * tradingMinutes : 0;
  const shouldFilterTurnover = hasTradingMinutes || minTurnoverPerMinute > 0;

  let bestSymbol: string | null = null;
  let bestName: string | null = null;
  let bestPrice = 0;
  let bestTurnover = 0;
  let bestTurnoverPerMinute = 0;

  for (const warrant of warrants) {
    if (!warrant?.symbol) {
      continue;
    }
    if (!isNormalStatus(warrant.status)) {
      continue;
    }

    const price = decimalToNumber(warrant.lastDone);
    if (!Number.isFinite(price) || price < minPrice) {
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

    if (
      bestSymbol === null ||
      price < bestPrice ||
      (price === bestPrice && turnoverPerMinute > bestTurnoverPerMinute)
    ) {
      bestSymbol = warrant.symbol;
      bestName = warrant.name ?? null;
      bestPrice = price;
      bestTurnover = turnover;
      bestTurnoverPerMinute = turnoverPerMinute;
    }
  }

  if (!bestSymbol) {
    return null;
  }

  return {
    symbol: bestSymbol,
    name: bestName,
    price: bestPrice,
    turnover: bestTurnover,
    turnoverPerMinute: bestTurnoverPerMinute,
  };
}

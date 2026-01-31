/**
 * 自动寻标工具：过滤候选与筛选最佳牛熊证。
 */
import { FilterWarrantExpiryDate, WarrantStatus } from 'longport';
import { decimalToNumber } from '../../utils/helpers/index.js';
import type { SelectBestWarrantInput, WarrantCandidate, WarrantListItem } from './types.js';

// 统一兼容不同枚举值的「正常」状态
function isNormalStatus(status: WarrantListItem['status']): boolean {
  return status === WarrantStatus.Normal || status === 'Normal' || status === 2;
}

/**
 * 根据最小到期月数生成筛选条件，避免临近到期标的。
 */
export function buildExpiryDateFilters(
  expiryMinMonths: number,
): ReadonlyArray<FilterWarrantExpiryDate> {
  if (!Number.isFinite(expiryMinMonths) || expiryMinMonths <= 3) {
    return [
      FilterWarrantExpiryDate.Between_3_6,
      FilterWarrantExpiryDate.Between_6_12,
      FilterWarrantExpiryDate.GT_12,
    ];
  }
  if (expiryMinMonths <= 6) {
    return [
      FilterWarrantExpiryDate.Between_6_12,
      FilterWarrantExpiryDate.GT_12,
    ];
  }
  return [FilterWarrantExpiryDate.GT_12];
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
  let best: WarrantCandidate | null = null;

  for (const warrant of warrants) {
    if (!warrant?.symbol) {
      continue;
    }
    if (!isNormalStatus(warrant.status)) {
      continue;
    }
    const turnover = decimalToNumber(warrant.turnover);
    if (!Number.isFinite(turnover) || turnover <= 0) {
      continue;
    }

    const price = decimalToNumber(warrant.lastDone);
    if (!Number.isFinite(price) || price < minPrice) {
      continue;
    }

    const turnoverPerMinute = tradingMinutes > 0 ? turnover / tradingMinutes : 0;
    if (turnoverPerMinute < minTurnoverPerMinute) {
      continue;
    }

    const candidate: WarrantCandidate = {
      symbol: warrant.symbol,
      name: warrant.name ?? null,
      price,
      turnover,
      turnoverPerMinute,
    };

    if (
      !best ||
      candidate.price < best.price ||
      (candidate.price === best.price && candidate.turnoverPerMinute > best.turnoverPerMinute)
    ) {
      best = candidate;
    }
  }

  return best;
}

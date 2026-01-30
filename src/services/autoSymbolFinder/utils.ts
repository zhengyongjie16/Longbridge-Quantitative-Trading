import { FilterWarrantExpiryDate, WarrantStatus } from 'longport';
import { decimalToNumber } from '../../utils/helpers/index.js';
import type { SelectBestWarrantInput, WarrantCandidate, WarrantListItem } from './types.js';

function isNormalStatus(status: WarrantListItem['status']): boolean {
  return status === WarrantStatus.Normal || status === 'Normal' || status === 2;
}

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

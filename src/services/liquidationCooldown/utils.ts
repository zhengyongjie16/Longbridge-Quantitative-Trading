/**
 * 清仓冷却模块工具函数
 */
import { TIME } from '../../constants/index.js';
import type { TradeRecord } from '../../core/trader/types.js';
import type { SeatSymbolSnapshotEntry } from '../../types/index.js';
import type { CooldownCandidate, LiquidationDirection } from './types.js';

/**
 * 构建冷却记录的 key
 */
export function buildCooldownKey(symbol: string, direction: LiquidationDirection): string {
  return `${symbol}:${direction}`;
}

/**
 * 将分钟转换为毫秒，非正数返回 0
 */
export function convertMinutesToMs(minutes: number): number {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return 0;
  }
  return Math.floor(minutes * 60_000);
}

/**
 * 获取香港时区的小时与分钟
 */
/**
 * 基于香港时区日期计算目标时间的 UTC 毫秒
 */
export function resolveHongKongTimeMs({
  baseTimestampMs,
  hour,
  minute,
  dayOffset = 0,
}: {
  readonly baseTimestampMs: number;
  readonly hour: number;
  readonly minute: number;
  readonly dayOffset?: number;
}): number | null {
  if (!Number.isFinite(baseTimestampMs)) {
    return null;
  }
  const offsetMs = TIME.BEIJING_TIMEZONE_OFFSET_MS;
  const hkDate = new Date(baseTimestampMs + offsetMs);
  const year = hkDate.getUTCFullYear();
  const month = hkDate.getUTCMonth();
  const day = hkDate.getUTCDate() + dayOffset;
  const targetHkMs = Date.UTC(year, month, day, hour, minute, 0, 0);
  return targetHkMs - offsetMs;
}

export const toStringOrNull = (value: unknown): string | null => {
  return typeof value === 'string' && value.trim() ? value : null;
};

export const toNumberOrNull = (value: unknown): number | null => {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

export const toBooleanOrNull = (value: unknown): boolean | null => {
  return value === true || value === false ? value : null;
};

export function resolveCooldownCandidatesBySeat({
  seatSymbols,
  tradeRecords,
}: {
  readonly seatSymbols: ReadonlyArray<SeatSymbolSnapshotEntry>;
  readonly tradeRecords: ReadonlyArray<TradeRecord>;
}): ReadonlyArray<CooldownCandidate> {
  if (seatSymbols.length === 0 || tradeRecords.length === 0) {
    return [];
  }

  const seatSymbolSet = new Set(seatSymbols.map((seat) => seat.symbol));
  const lastBySymbol = new Map<string, TradeRecord>();

  for (const record of tradeRecords) {
    const symbol = record.symbol;
    const executedAtMs = record.executedAtMs;
    if (!symbol || typeof executedAtMs !== 'number' || !Number.isFinite(executedAtMs)) {
      continue;
    }
    if (!seatSymbolSet.has(symbol)) {
      continue;
    }
    const existing = lastBySymbol.get(symbol);
    const existingTime =
      existing && typeof existing.executedAtMs === 'number' ? existing.executedAtMs : 0;
    if (!existing || existingTime < executedAtMs) {
      lastBySymbol.set(symbol, record);
    }
  }

  const candidates: CooldownCandidate[] = [];
  for (const seat of seatSymbols) {
    const record = lastBySymbol.get(seat.symbol);
    if (!record) {
      continue;
    }
    const executedAtMs = record.executedAtMs;
    if (typeof executedAtMs !== 'number' || !Number.isFinite(executedAtMs)) {
      continue;
    }
    if (record.isProtectiveClearance !== true) {
      continue;
    }
    candidates.push({
      monitorSymbol: seat.monitorSymbol,
      direction: seat.direction,
      executedAtMs,
    });
  }

  return candidates;
}

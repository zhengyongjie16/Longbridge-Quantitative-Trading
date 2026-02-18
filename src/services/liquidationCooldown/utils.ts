import { TIME } from '../../constants/index.js';
import type { TradeRecord } from '../../core/trader/types.js';
import type { SeatSymbolSnapshotEntry } from '../../types/seat.js';
import type { CooldownCandidate } from './types.js';

/**
 * 构建冷却记录的 key
 * @param symbol 标的代码
 * @param direction 方向（LONG / SHORT）
 * @returns 格式为 `symbol:direction` 的字符串键
 */
export function buildCooldownKey(symbol: string, direction: 'LONG' | 'SHORT'): string {
  return `${symbol}:${direction}`;
}

/**
 * 将分钟转换为毫秒，非正数返回 0
 * @param minutes 分钟数
 * @returns 对应的毫秒数，非正数时返回 0
 */
export function convertMinutesToMs(minutes: number): number {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return 0;
  }
  return Math.floor(minutes * 60_000);
}

/**
 * 基于香港时区日期计算目标时间的 UTC 毫秒
 * @param params.baseTimestampMs 基准时间戳（UTC 毫秒）
 * @param params.hour 目标香港时间小时
 * @param params.minute 目标香港时间分钟
 * @param params.dayOffset 日期偏移天数，默认为 0
 * @returns 目标时间的 UTC 毫秒，baseTimestampMs 无效时返回 null
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
  const offsetMs = TIME.HONG_KONG_TIMEZONE_OFFSET_MS;
  const hkDate = new Date(baseTimestampMs + offsetMs);
  const year = hkDate.getUTCFullYear();
  const month = hkDate.getUTCMonth();
  const day = hkDate.getUTCDate() + dayOffset;
  const targetHkMs = Date.UTC(year, month, day, hour, minute, 0, 0);
  return targetHkMs - offsetMs;
}

/**
 * 将未知值转换为字符串，非空字符串时返回原值，否则返回 null
 * @param value 待转换的值
 * @returns 非空字符串时返回该字符串，否则返回 null
 */
export function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * 将未知值转换为有限数字，非有限数字时返回 null
 * @param value 待转换的值
 * @returns 有限数字时返回该数字，否则返回 null
 */
export function toNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 将未知值转换为布尔值，非布尔类型时返回 null
 * @param value 待转换的值
 * @returns 布尔值时返回该值，否则返回 null
 */
export function toBooleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** 按席位从成交记录中筛选最后一条保护性清仓记录，用于冷却恢复。
 * @param params.seatSymbols 当前席位标的快照列表
 * @param params.tradeRecords 历史成交记录列表
 * @returns 每个席位对应的最后一条保护性清仓候选记录数组
 */
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

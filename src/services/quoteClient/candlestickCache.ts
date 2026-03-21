/**
 * quoteClient K 线本地缓存模块
 *
 * 职责：
 * - 维护 symbol + period 维度的 K 线快照
 * - 处理订阅 seed 与 push 增量更新（append / replace / ignore-old-event）
 * - 提供只读快照读取与清理能力
 */
import type { Period } from 'longbridge';
import type { CandleData } from '../../types/data.js';
import type { CandlestickCacheSnapshot } from '../../types/services.js';
import { isRecord } from '../../utils/helpers/index.js';

/**
 * K 线缓存存储结构。
 * 类型用途：维护缓存快照映射与单 key 最大保留根数。
 * 数据来源：createCandlestickCacheStore 创建。
 * 使用范围：quoteClient 模块内部使用。
 */
export type CandlestickCacheStore = {
  readonly maxCandles: number;
  readonly snapshots: Map<string, CandlestickCacheSnapshot>;
};

/**
 * seed K 线序列参数。
 * 类型用途：订阅成功后将初始 K 线序列写入本地缓存。
 * 数据来源：subscribeCandlesticks 返回值。
 * 使用范围：quoteClient 模块内部使用。
 */
export type SeedCandlestickSeriesParams = {
  readonly store: CandlestickCacheStore;
  readonly symbol: string;
  readonly period: Period;
  readonly candles: ReadonlyArray<unknown>;
};

/**
 * push 更新参数。
 * 类型用途：处理 setOnCandlestick 推送事件并更新本地缓存。
 * 数据来源：QuoteContext candlestick push event。
 * 使用范围：quoteClient 模块内部使用。
 */
export type ApplyCandlestickPushParams = {
  readonly store: CandlestickCacheStore;
  readonly symbol: string;
  readonly period: Period;
  readonly candlestick: unknown;
  readonly isConfirmed: boolean;
};

type NormalizedCandleValue = number | string | null | undefined;

function normalizeRecordToNumber(value: Record<string, unknown>): number | undefined {
  const toNumberFn: unknown = Reflect.get(value, 'toNumber');
  if (typeof toNumberFn !== 'function') {
    return undefined;
  }

  const normalized: unknown = Reflect.apply(toNumberFn, value, []);
  return typeof normalized === 'number' && Number.isFinite(normalized) ? normalized : undefined;
}

/**
 * 创建缓存 key（symbol:period）。
 *
 * @param symbol 标的代码
 * @param period K 线周期
 * @returns 缓存 key
 */
function createCandlestickKey(symbol: string, period: Period): string {
  return `${symbol}:${String(period)}`;
}

/**
 * 标准化 K 线数值字段。
 *
 * @param value 原始字段值
 * @returns 标准化后的 CandleValue 兼容值
 */
function normalizeCandleValue(value: unknown): NormalizedCandleValue {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return value;
  }

  if (isRecord(value)) {
    return normalizeRecordToNumber(value);
  }

  return undefined;
}

/**
 * 标准化 K 线时间戳（毫秒）。
 *
 * @param value 原始 timestamp 字段
 * @returns 有效毫秒时间戳；无效时返回 undefined
 */
function normalizeTimestamp(value: unknown): number | undefined {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : undefined;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : undefined;
  }

  return undefined;
}

/**
 * 标准化单根 K 线。
 *
 * @param candle 原始 K 线
 * @returns CandleData（当结构非法时返回 null）
 */
function normalizeCandlestick(candle: unknown): CandleData | null {
  if (!isRecord(candle)) {
    return null;
  }

  const normalizedTimestamp = normalizeTimestamp(candle['timestamp']);
  return {
    open: normalizeCandleValue(candle['open']),
    high: normalizeCandleValue(candle['high']),
    low: normalizeCandleValue(candle['low']),
    close: normalizeCandleValue(candle['close']),
    volume: normalizeCandleValue(candle['volume']),
    ...(normalizedTimestamp === undefined ? {} : { timestamp: normalizedTimestamp }),
  };
}

/**
 * 标准化 K 线序列并裁剪到最大长度。
 *
 * @param candles 原始 K 线序列
 * @param maxCandles 最大保留根数
 * @returns 标准化后的 K 线数组
 */
function normalizeCandlestickSeries(
  candles: ReadonlyArray<unknown>,
  maxCandles: number,
): ReadonlyArray<CandleData> {
  const normalized: CandleData[] = [];
  for (const candle of candles) {
    const normalizedCandle = normalizeCandlestick(candle);
    if (normalizedCandle !== null) {
      normalized.push(normalizedCandle);
    }
  }

  if (normalized.length <= maxCandles) {
    return normalized;
  }

  return normalized.slice(normalized.length - maxCandles);
}

/**
 * 判断两根 K 线语义是否一致（用于 push 幂等判定）。
 *
 * @param left 左值
 * @param right 右值
 * @returns 是否语义一致
 */
function areCandlesEqual(left: CandleData | undefined, right: CandleData | undefined): boolean {
  if (!left || !right) {
    return false;
  }

  return (
    left.timestamp === right.timestamp &&
    left.open === right.open &&
    left.high === right.high &&
    left.low === right.low &&
    left.close === right.close &&
    left.volume === right.volume
  );
}

/**
 * 通过当前 candles 与 lastBarConfirmed 构造快照。
 *
 * @param params 快照构建参数
 * @returns CandlestickCacheSnapshot
 */
function buildSnapshot(params: {
  readonly symbol: string;
  readonly period: Period;
  readonly version: number;
  readonly candles: ReadonlyArray<CandleData>;
  readonly lastBarConfirmed: boolean | null;
  readonly initialized: boolean;
}): CandlestickCacheSnapshot {
  const latestCandle = params.candles.at(-1);
  const lastBarTimestamp =
    latestCandle &&
    typeof latestCandle.timestamp === 'number' &&
    Number.isFinite(latestCandle.timestamp)
      ? latestCandle.timestamp
      : null;
  return {
    symbol: params.symbol,
    period: params.period,
    version: params.version,
    candles: [...params.candles],
    lastBarTimestamp,
    lastBarConfirmed: params.lastBarConfirmed,
    initialized: params.initialized,
  };
}

/**
 * 创建 K 线缓存存储。
 *
 * @param params 可选参数（maxCandles）
 * @returns 缓存存储对象
 */
export function createCandlestickCacheStore(params: {
  readonly maxCandles: number;
}): CandlestickCacheStore {
  return {
    maxCandles: params.maxCandles,
    snapshots: new Map<string, CandlestickCacheSnapshot>(),
  };
}

/**
 * 订阅 seed：写入初始 K 线快照。
 *
 * @param params seed 参数
 * @returns 写入后的快照
 */
export function seedCandlestickSeries(
  params: SeedCandlestickSeriesParams,
): CandlestickCacheSnapshot {
  const { store, symbol, period, candles } = params;
  const key = createCandlestickKey(symbol, period);
  const existing = store.snapshots.get(key) ?? null;
  const normalizedCandles = normalizeCandlestickSeries(candles, store.maxCandles);
  const nextVersion = existing === null ? 1 : existing.version + 1;
  const snapshot = buildSnapshot({
    symbol,
    period,
    version: nextVersion,
    candles: normalizedCandles,
    lastBarConfirmed: null,
    initialized: true,
  });
  store.snapshots.set(key, snapshot);
  return snapshot;
}

/**
 * 处理单条 push 更新。
 *
 * @param params push 参数
 * @returns 最新快照；若对应 key 尚未 seed 则返回 null
 */
export function applyCandlestickPush(
  params: ApplyCandlestickPushParams,
): CandlestickCacheSnapshot | null {
  const { store, symbol, period, candlestick, isConfirmed } = params;
  const key = createCandlestickKey(symbol, period);
  const currentSnapshot = store.snapshots.get(key) ?? null;
  if (!currentSnapshot?.initialized) {
    return null;
  }

  const normalizedCandle = normalizeCandlestick(candlestick);
  if (normalizedCandle?.timestamp === undefined) {
    return currentSnapshot;
  }

  const incomingTimestamp = normalizedCandle.timestamp;
  const lastTimestamp = currentSnapshot.lastBarTimestamp;
  const currentCandles = currentSnapshot.candles;
  if (lastTimestamp !== null && incomingTimestamp < lastTimestamp) {
    return currentSnapshot;
  }

  if (lastTimestamp !== null && incomingTimestamp === lastTimestamp) {
    // 收线确认具有单调性：同 timestamp 一旦 confirmed=true，后续 false 事件视为乱序旧事件直接忽略。
    if (currentSnapshot.lastBarConfirmed === true && !isConfirmed) {
      return currentSnapshot;
    }

    const nextLastBarConfirmed = currentSnapshot.lastBarConfirmed === true ? true : isConfirmed;
    const previousLastCandle = currentCandles.at(-1);
    const candleChanged = !areCandlesEqual(previousLastCandle, normalizedCandle);
    const confirmedChanged = currentSnapshot.lastBarConfirmed !== nextLastBarConfirmed;
    if (!candleChanged && !confirmedChanged) {
      return currentSnapshot;
    }

    const nextCandles =
      currentCandles.length === 0
        ? [normalizedCandle]
        : [...currentCandles.slice(0, -1), normalizedCandle];
    const updatedSnapshot = buildSnapshot({
      symbol,
      period,
      version: currentSnapshot.version + 1,
      candles: nextCandles,
      lastBarConfirmed: nextLastBarConfirmed,
      initialized: true,
    });
    store.snapshots.set(key, updatedSnapshot);
    return updatedSnapshot;
  }

  const appendedCandles =
    currentCandles.length + 1 <= store.maxCandles
      ? [...currentCandles, normalizedCandle]
      : [...currentCandles.slice(currentCandles.length + 1 - store.maxCandles), normalizedCandle];
  const updatedSnapshot = buildSnapshot({
    symbol,
    period,
    version: currentSnapshot.version + 1,
    candles: appendedCandles,
    lastBarConfirmed: isConfirmed,
    initialized: true,
  });
  store.snapshots.set(key, updatedSnapshot);
  return updatedSnapshot;
}

/**
 * 读取指定 symbol + period 的快照。
 *
 * @param params 查询参数
 * @returns 快照，不存在时返回 null
 */
export function getCandlestickSnapshot(params: {
  readonly store: CandlestickCacheStore;
  readonly symbol: string;
  readonly period: Period;
}): CandlestickCacheSnapshot | null {
  const key = createCandlestickKey(params.symbol, params.period);
  return params.store.snapshots.get(key) ?? null;
}

/**
 * 清理 K 线快照。
 * 未传 keys 时清空全部；传 keys 时仅删除指定 key。
 *
 * @param params 清理参数
 * @returns void
 */
export function clearCandlestickSnapshots(params: {
  readonly store: CandlestickCacheStore;
  readonly keys?: ReadonlyArray<{ readonly symbol: string; readonly period: Period }>;
}): void {
  const { store, keys } = params;
  if (!keys || keys.length === 0) {
    store.snapshots.clear();
    return;
  }

  for (const key of keys) {
    store.snapshots.delete(createCandlestickKey(key.symbol, key.period));
  }
}

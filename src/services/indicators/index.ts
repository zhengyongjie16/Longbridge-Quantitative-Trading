/**
 * 技术指标计算模块
 *
 * 功能：
 * - 计算 RSI（相对强弱指标）
 * - 计算 MFI（资金流量指标）
 * - 计算 PSY（心理线指标）
 * - 计算 KDJ（随机指标）
 * - 计算 MACD（指数平滑异同移动平均线）
 * - 计算 EMA（指数移动平均线）
 * - 构建包含所有指标的统一快照
 *
 * 实现方式：
 * - 使用 technicalindicators 库优化指标计算
 * - 使用缓存减少重复计算（K 线数据未变时跳过计算）
 *
 * 指标参数：
 * - RSI：周期 6，Wilder's Smoothing 平滑
 * - MFI：周期 14，结合价格和成交量
 * - KDJ：EMA 周期 5，K、D、J 三值
 * - MACD：EMA12-EMA26-DIF 的 EMA9
 */

import { validateRsiPeriod, validateEmaPeriod, validatePsyPeriod } from '../../utils/helpers/indicatorHelpers.js';
import { periodRecordPool } from '../../utils/objectPool/index.js';
import { toNumber } from './utils.js';
import { calculateRSI } from './rsi.js';
import { calculateMFI } from './mfi.js';
import { calculateKDJ } from './kdj.js';
import { calculateMACD } from './macd.js';
import { calculateEMA } from './ema.js';
import { calculatePSY } from './psy.js';
import type { CandleData, IndicatorSnapshot } from '../../types/index.js';

// ==================== 指标缓存 ====================

/** 缓存 TTL（毫秒） */
const CACHE_TTL_MS = 5000;

/** 最大缓存条目数（防止内存泄漏） */
const MAX_CACHE_SIZE = 50;

/** 缓存条目类型 */
type IndicatorCalculationCacheEntry = {
  readonly snapshot: IndicatorSnapshot;
  readonly timestamp: number;
  readonly dataFingerprint: string;
};

/** 指标计算结果缓存 */
const indicatorCache = new Map<string, IndicatorCalculationCacheEntry>();

/**
 * 构建缓存键
 * @param symbol 标的代码
 * @param rsiPeriods RSI 周期数组
 * @param emaPeriods EMA 周期数组
 * @param psyPeriods PSY 周期数组
 */
function buildCacheKey(
  symbol: string,
  rsiPeriods: ReadonlyArray<number>,
  emaPeriods: ReadonlyArray<number>,
  psyPeriods: ReadonlyArray<number>,
): string {
  return `${symbol}_${rsiPeriods.join(',')}_${emaPeriods.join(',')}_${psyPeriods.join(',')}`;
}

/**
 * 构建 K 线数据指纹（用于检测数据是否变化）
 * 使用数组长度 + 最后收盘价作为指纹，因为：
 * - K 线数据更新时，最后一根收盘价一定会变化
 * - 数组长度变化也意味着数据更新
 * @param candles K 线数据数组
 * @param lastClose 最后收盘价（已计算）
 */
function buildDataFingerprint(
  candles: ReadonlyArray<CandleData>,
  lastClose: number,
): string {
  return `${candles.length}_${lastClose}`;
}

/**
 * 释放缓存条目中的对象池对象
 * @param entry 缓存条目
 */
function releaseCacheEntryObjects(entry: IndicatorCalculationCacheEntry): void {
  // 释放 rsi、ema、psy 对象回对象池
  if (entry.snapshot.rsi) {
    periodRecordPool.release(entry.snapshot.rsi);
  }
  if (entry.snapshot.ema) {
    periodRecordPool.release(entry.snapshot.ema);
  }
  if (entry.snapshot.psy) {
    periodRecordPool.release(entry.snapshot.psy);
  }
}

function deleteCacheEntry(key: string, entry: IndicatorCalculationCacheEntry): void {
  releaseCacheEntryObjects(entry);
  indicatorCache.delete(key);
}

/**
 * 清理过期缓存条目
 * 当缓存条目超过最大数量时，删除最旧的条目
 */
function cleanupCache(): void {
  if (indicatorCache.size <= MAX_CACHE_SIZE) {
    return;
  }

  const now = Date.now();
  const expiredEntries: Array<[string, IndicatorCalculationCacheEntry]> = [];

  // 首先删除过期条目
  for (const [key, entry] of indicatorCache) {
    if (now - entry.timestamp > CACHE_TTL_MS) {
      expiredEntries.push([key, entry]);
    }
  }

  for (const [key, entry] of expiredEntries) {
    deleteCacheEntry(key, entry);
  }

  // 如果仍然超过限制，删除最旧的条目
  if (indicatorCache.size > MAX_CACHE_SIZE) {
    const sortedEntries = [...indicatorCache.entries()].sort(
      (a, b) => a[1].timestamp - b[1].timestamp,
    );
    const deleteCount = indicatorCache.size - MAX_CACHE_SIZE;
    for (let i = 0; i < deleteCount; i++) {
      const sortedEntry = sortedEntries[i];
      if (sortedEntry) {
        deleteCacheEntry(sortedEntry[0], sortedEntry[1]);
      }
    }
  }
}

/**
 * 构建指标快照（统一计算所有技术指标）
 *
 * - 使用缓存减少重复计算
 * - 通过 K 线数据指纹检测数据是否变化
 * - 5 秒 TTL 确保数据时效性
 * - 缓存命中时避免遍历整个 K 线数组
 *
 * @param symbol 标的代码
 * @param candles K线数据数组
 * @param rsiPeriods RSI周期数组
 * @param emaPeriods EMA周期数组
 * @param psyPeriods PSY周期数组
 * @returns 指标快照对象
 */
export function buildIndicatorSnapshot(
  symbol: string,
  candles: ReadonlyArray<CandleData>,
  rsiPeriods: ReadonlyArray<number> = [],
  emaPeriods: ReadonlyArray<number> = [],
  psyPeriods: ReadonlyArray<number> = [],
): IndicatorSnapshot | null {
  if (!candles || candles.length === 0) {
    return null;
  }

  const cacheKey = buildCacheKey(symbol, rsiPeriods, emaPeriods, psyPeriods);

  // ========== 轻量级缓存检查（避免遍历整个数组） ==========
  // 先用最后一根 K 线的收盘价构建指纹，检查缓存
  const lastCandle = candles.at(-1);
  const lastCandleClose = lastCandle ? toNumber(lastCandle.close) : 0;

  // 只有当最后收盘价有效时才检查缓存
  if (Number.isFinite(lastCandleClose) && lastCandleClose > 0) {
    const dataFingerprint = buildDataFingerprint(candles, lastCandleClose);
    const cached = indicatorCache.get(cacheKey);
    const now = Date.now();

    // 检查缓存是否有效：
    // 1. 缓存存在
    // 2. 未过期（5 秒 TTL）
    // 3. K 线数据未变化（指纹相同）
    if (
      cached &&
      now - cached.timestamp < CACHE_TTL_MS &&
      cached.dataFingerprint === dataFingerprint
    ) {
      return cached.snapshot;
    }
  }

  // ========== 缓存未命中，提取完整收盘价数组 ==========
  const validCloses: number[] = [];
  for (const element of candles) {
    const close = toNumber(element.close);
    if (Number.isFinite(close) && close > 0) {
      validCloses.push(close);
    }
  }

  if (validCloses.length === 0) {
    return null;
  }

  const lastPrice = validCloses.at(-1)!;

  // ========== 计算指标 ==========

  // 计算涨跌幅（如果有前一根K线的收盘价）
  let changePercent: number | null = null;
  if (validCloses.length >= 2) {
    const prevClose = validCloses.at(-2)!;
    if (Number.isFinite(prevClose) && prevClose > 0) {
      changePercent = ((lastPrice - prevClose) / prevClose) * 100;
    }
  }

  // 计算所有需要的 RSI 周期
  // 从对象池获取 rsi 对象，减少内存分配
  const rsi = periodRecordPool.acquire();
  if (Array.isArray(rsiPeriods) && rsiPeriods.length > 0) {
    for (const period of rsiPeriods) {
      if (validateRsiPeriod(period) && Number.isInteger(period)) {
        const rsiValue = calculateRSI(validCloses, period);
        if (rsiValue !== null) {
          rsi[period] = rsiValue;
        }
      }
    }
  }

  // 计算所有需要的 EMA 周期
  // 从对象池获取 ema 对象，减少内存分配
  const ema = periodRecordPool.acquire();
  if (Array.isArray(emaPeriods) && emaPeriods.length > 0) {
    for (const period of emaPeriods) {
      if (validateEmaPeriod(period) && Number.isInteger(period)) {
        const emaValue = calculateEMA(validCloses, period);
        if (emaValue !== null) {
          ema[period] = emaValue;
        }
      }
    }
  }

  // 计算所有需要的 PSY 周期
  // 从对象池获取 psy 对象，减少内存分配
  let psy: Record<number, number> | null = null;
  if (Array.isArray(psyPeriods) && psyPeriods.length > 0) {
    const psyRecord = periodRecordPool.acquire();
    let hasPsyValue = false;
    for (const period of psyPeriods) {
      if (validatePsyPeriod(period) && Number.isInteger(period)) {
        const psyValue = calculatePSY(validCloses, period);
        if (psyValue !== null) {
          psyRecord[period] = psyValue;
          hasPsyValue = true;
        }
      }
    }
    if (hasPsyValue) {
      psy = psyRecord;
    } else {
      periodRecordPool.release(psyRecord);
    }
  }

  const snapshot: IndicatorSnapshot = {
    symbol,
    price: lastPrice,
    changePercent,
    rsi,
    psy,
    kdj: calculateKDJ(candles, 9),
    macd: calculateMACD(validCloses),
    mfi: calculateMFI(candles, 14),
    ema,
  };

  // ========== 更新缓存 ==========
  const dataFingerprint = buildDataFingerprint(candles, lastPrice);
  const now = Date.now();

  // 释放旧缓存条目中的对象池对象（如果存在）
  const oldEntry = indicatorCache.get(cacheKey);
  if (oldEntry) {
    releaseCacheEntryObjects(oldEntry);
  }

  indicatorCache.set(cacheKey, {
    snapshot,
    timestamp: now,
    dataFingerprint,
  });

  // 定期清理过期缓存
  cleanupCache();

  return snapshot;
}

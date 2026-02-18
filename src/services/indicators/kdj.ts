/**
 * KDJ（随机指标）计算模块
 *
 * 指标参数：
 * - RSV 窗口周期：默认 9（计算最高价、最低价的窗口大小）
 * - EMA 平滑周期：5（用于平滑 RSV 得到 K，平滑 K 得到 D）
 * - J = 3K - 2D
 */
import { kdjObjectPool } from '../../utils/objectPool/index.js';
import { toNumber, logDebug, isValidKDJ } from './utils.js';
import type { KDJIndicator } from '../../types/quote.js';
import type { CandleData } from '../../types/data.js';
import type { EmaStream } from './types.js';

function computeSma(values: ReadonlyArray<number>): number {
  if (values.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const value of values) {
    sum += value;
  }
  return sum / values.length;
}

function createEmaStream(period: number): EmaStream {
  const buffer: number[] = [];
  const per = 2 / (period + 1);
  let emaValue: number | undefined;

  return {
    nextValue(value: number): number | undefined {
      if (!Number.isFinite(value)) {
        return undefined;
      }

      if (emaValue === undefined) {
        buffer.push(value);
        if (buffer.length < period) {
          return undefined;
        }
        emaValue = computeSma(buffer);
        return emaValue;
      }

      emaValue = (value - emaValue) * per + emaValue;
      return emaValue;
    },
  };
}

/**
 * 计算 KDJ（随机指标）
 * @param candles K线数据数组
 * @param period KDJ周期，默认9
 * @returns KDJ对象 {k, d, j}，如果无法计算则返回null
 */
export function calculateKDJ(candles: ReadonlyArray<CandleData>, period: number = 9): KDJIndicator | null {
  if (!candles || candles.length < period) {
    return null;
  }

  try {
    const emaPeriod = 5;

    // 优化：预先提取所有high、low、close值,避免重复toNumber转换
    const highs: number[] = [];
    const lows: number[] = [];
    const closes: number[] = [];

    for (const candle of candles) {
      highs.push(toNumber(candle.high));
      lows.push(toNumber(candle.low));
      closes.push(toNumber(candle.close));
    }

    // 步骤1：计算所有 RSV 值
    const rsvValues: number[] = [];
    for (let i = period - 1; i < candles.length; i += 1) {
      const windowStart = i - period + 1;
      let highestHigh = Number.NEGATIVE_INFINITY;
      let lowestLow = Number.POSITIVE_INFINITY;
      let hasHigh = false;
      let hasLow = false;

      for (let j = windowStart; j <= i; j += 1) {
        const high = highs[j]!;
        if (Number.isFinite(high)) {
          if (high > highestHigh) {
            highestHigh = high;
          }
          hasHigh = true;
        }

        const low = lows[j]!;
        if (Number.isFinite(low)) {
          if (low < lowestLow) {
            lowestLow = low;
          }
          hasLow = true;
        }
      }

      const close = closes[i]!;

      if (!hasHigh || !hasLow || !Number.isFinite(close)) {
        continue;
      }

      const range = highestHigh - lowestLow;

      if (!Number.isFinite(range) || range === 0) {
        continue;
      }

      const rsv = ((close - lowestLow) / range) * 100;
      rsvValues.push(rsv);
    }

    if (rsvValues.length === 0) {
      return null;
    }

    // 步骤2：使用 EMA(period=5) 平滑 RSV 得到 K 值
    const emaK = createEmaStream(emaPeriod);
    const kValues: number[] = [];
    emaK.nextValue(50);
    for (const rsv of rsvValues) {
      const kValue = emaK.nextValue(rsv);
      if (kValue === undefined) {
        kValues.push(kValues.length > 0 ? kValues.at(-1)! : 50);
      } else {
        kValues.push(kValue);
      }
    }

    // 步骤3：使用 EMA(period=5) 平滑 K 值得到 D 值
    const emaD = createEmaStream(emaPeriod);
    const dValues: number[] = [];
    emaD.nextValue(50);
    for (const kv of kValues) {
      const dValue = emaD.nextValue(kv);
      if (dValue === undefined) {
        dValues.push(dValues.length > 0 ? dValues.at(-1)! : 50);
      } else {
        dValues.push(dValue);
      }
    }

    // 获取最后的 K 和 D 值
    const k = kValues.at(-1);
    const d = dValues.at(-1);

    if (k === undefined || d === undefined) {
      return null;
    }

    // 步骤4：计算J值
    const j = 3 * k - 2 * d;

    if (Number.isFinite(k) && Number.isFinite(d) && Number.isFinite(j)) {
      const kdjObj = kdjObjectPool.acquire();
      kdjObj.k = k;
      kdjObj.d = d;
      kdjObj.j = j;

      // 使用类型守卫验证对象有效性
      if (isValidKDJ(kdjObj)) {
        return kdjObj;
      }

      // 如果类型验证失败，释放对象并返回 null
      kdjObjectPool.release(kdjObj);
    }

    return null;
  } catch (err) {
    logDebug('KDJ计算失败', err);
    return null;
  }
}

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

/**
 * 计算数组的简单算术平均，用于 KDJ 中 EMA 流的种子期。
 * @param values - 数值数组
 * @returns 算术平均值，空数组返回 0
 */
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

/**
 * 创建单条 EMA 流：前 period 个值用 SMA 做种子，之后按 EMA 递推，供 K/D 平滑使用。
 * @param period - EMA 周期
 * @returns EmaStream，nextValue 喂入新值并返回当前 EMA，种子期未满时返回 undefined
 */
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
export function calculateKDJ(
  candles: ReadonlyArray<CandleData>,
  period: number = 9,
): KDJIndicator | null {
  if (candles.length < period) {
    return null;
  }

  try {
    const emaPeriod = 5;

    // 单调队列：同时维护窗口最高/最低，并在同一轮流式推进 K 与 D，避免中间序列落地。
    const maxIndexDeque = new Int32Array(candles.length);
    const maxValueDeque = new Float64Array(candles.length);
    const minIndexDeque = new Int32Array(candles.length);
    const minValueDeque = new Float64Array(candles.length);
    let maxHead = 0;
    let maxTail = 0;
    let minHead = 0;
    let minTail = 0;

    const emaK = createEmaStream(emaPeriod);
    const emaD = createEmaStream(emaPeriod);
    emaK.nextValue(50);
    emaD.nextValue(50);

    let hasKdjValue = false;
    let lastK = 50;
    let lastD = 50;

    for (const [i, candle] of candles.entries()) {
      const high = toNumber(candle.high);
      if (Number.isFinite(high)) {
        while (maxTail > maxHead) {
          const lastQueueIndex = maxTail - 1;
          const lastValue = maxValueDeque[lastQueueIndex];
          if (lastValue === undefined || lastValue <= high) {
            maxTail -= 1;
            continue;
          }

          break;
        }

        maxIndexDeque[maxTail] = i;
        maxValueDeque[maxTail] = high;
        maxTail += 1;
      }

      const low = toNumber(candle.low);
      if (Number.isFinite(low)) {
        while (minTail > minHead) {
          const lastQueueIndex = minTail - 1;
          const lastValue = minValueDeque[lastQueueIndex];
          if (lastValue === undefined || lastValue >= low) {
            minTail -= 1;
            continue;
          }

          break;
        }

        minIndexDeque[minTail] = i;
        minValueDeque[minTail] = low;
        minTail += 1;
      }

      if (i < period - 1) {
        continue;
      }

      const windowStart = i - period + 1;
      while (maxTail > maxHead) {
        const index = maxIndexDeque[maxHead];
        if (index !== undefined && index < windowStart) {
          maxHead += 1;
          continue;
        }

        break;
      }

      while (minTail > minHead) {
        const index = minIndexDeque[minHead];
        if (index !== undefined && index < windowStart) {
          minHead += 1;
          continue;
        }

        break;
      }

      const highestHigh = maxValueDeque[maxHead];
      const lowestLow = minValueDeque[minHead];
      if (highestHigh === undefined || lowestLow === undefined) {
        continue;
      }

      const close = toNumber(candle.close);
      if (!Number.isFinite(close)) {
        continue;
      }

      const range = highestHigh - lowestLow;
      if (!Number.isFinite(range) || range === 0) {
        continue;
      }

      const rsv = ((close - lowestLow) / range) * 100;
      const kValue = emaK.nextValue(rsv);
      if (kValue !== undefined) {
        lastK = kValue;
      }

      const dValue = emaD.nextValue(lastK);
      if (dValue !== undefined) {
        lastD = dValue;
      }

      hasKdjValue = true;
    }

    if (!hasKdjValue) {
      return null;
    }

    // 计算J值
    const j = 3 * lastK - 2 * lastD;

    if (Number.isFinite(lastK) && Number.isFinite(lastD) && Number.isFinite(j)) {
      const kdjObj = kdjObjectPool.acquire();
      kdjObj.k = lastK;
      kdjObj.d = lastD;
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

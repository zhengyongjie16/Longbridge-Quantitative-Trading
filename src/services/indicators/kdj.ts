/**
 * KDJ（随机指标）计算模块
 *
 * 指标参数：
 * - KDJ：EMA 周期 5，K、D、J 三值
 */

import { EMA } from 'technicalindicators';
import { kdjObjectPool } from '../../utils/objectPool/index.js';
import { isValidKDJ } from '../../utils/objectPool/types.js';
import { toNumber, logDebug } from './utils.js';
import type { KDJIndicator, CandleData } from '../../types/index.js';

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

    // 步骤1：计算所有 RSV 值
    const rsvValues: number[] = [];
    for (let i = period - 1; i < candles.length; i += 1) {
      const window = candles.slice(i - period + 1, i + 1);

      const windowHighs = window
        .map((c) => toNumber(c.high))
        .filter((v) => Number.isFinite(v));
      const windowLows = window
        .map((c) => toNumber(c.low))
        .filter((v) => Number.isFinite(v));
      const lastCandle = window.at(-1);
      const close = toNumber(lastCandle?.close);

      if (
        windowHighs.length === 0 ||
        windowLows.length === 0 ||
        !Number.isFinite(close)
      ) {
        continue;
      }

      const highestHigh = Math.max(...windowHighs);
      const lowestLow = Math.min(...windowLows);
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
    const emaK = new EMA({ period: emaPeriod, values: [] });
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
    const emaD = new EMA({ period: emaPeriod, values: [] });
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

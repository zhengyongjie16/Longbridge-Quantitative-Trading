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
 * - K 线未变时的复用由 pipeline 层负责（见 indicatorPipeline + getCandleFingerprint）
 *
 * 指标参数（默认值，可配置）：
 * - RSI：支持多周期配置，常用周期 6、14
 * - MFI：周期 14，结合价格和成交量
 * - PSY：支持多周期配置，统计周期内上涨天数占比
 * - KDJ：RSV 周期 9，EMA 平滑周期 5，计算 K、D、J 三值
 * - MACD：快线 EMA12、慢线 EMA26、信号线 EMA9
 * - EMA：支持多周期配置，范围 1-250
 */
import { validateRsiPeriod, validateEmaPeriod, validatePsyPeriod } from '../../utils/helpers/indicatorHelpers.js';
import { isValidPositiveNumber } from '../../utils/helpers/index.js';
import { periodRecordPool } from '../../utils/objectPool/index.js';
import { toNumber } from './utils.js';
import { calculateRSI } from './rsi.js';
import { calculateMFI } from './mfi.js';
import { calculateKDJ } from './kdj.js';
import { calculateMACD } from './macd.js';
import { calculateEMA } from './ema.js';
import { calculatePSY } from './psy.js';
import type { CandleData } from '../../types/data.js';
import type { IndicatorSnapshot } from '../../types/quote.js';

/**
 * 构建指标快照（统一计算所有技术指标）
 *
 * 由 pipeline 负责「K 线未变则复用上一拍快照」的短路，本函数仅做纯计算。
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

  const validCloses: number[] = [];
  for (const element of candles) {
    const close = toNumber(element.close);
    if (isValidPositiveNumber(close)) {
      validCloses.push(close);
    }
  }

  if (validCloses.length === 0) {
    return null;
  }

  const lastPrice = validCloses.at(-1)!;

  // 计算涨跌幅（如果有前一根K线的收盘价）
  let changePercent: number | null = null;
  if (validCloses.length >= 2) {
    const prevClose = validCloses.at(-2)!;
    if (isValidPositiveNumber(prevClose)) {
      changePercent = ((lastPrice - prevClose) / prevClose) * 100;
    }
  }

  // 计算所有需要的 RSI 周期
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

  return {
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
}

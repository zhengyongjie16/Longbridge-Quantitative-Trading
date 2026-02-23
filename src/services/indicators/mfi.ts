/**
 * MFI（资金流量指标）计算模块
 *
 * 指标参数：
 * - MFI：周期 14，结合价格和成交量
 */
import { isValidPositiveNumber } from '../../utils/helpers/index.js';
import { toNumber, logDebug } from './utils.js';
import { validatePercentage } from '../../utils/helpers/indicatorHelpers.js';
import type { CandleData } from '../../types/data.js';
import type { BufferNewPush } from './types.js';

/** 保留两位小数，与 RSI 等指标输出一致 */
function roundToFixed2(value: number): number {
  return Number.parseFloat(value.toFixed(2));
}

/** 向环形缓冲区追加一个值，满窗时覆盖最旧项并更新 sum（O(1) 滑动窗口） */
function pushBuffer(buffer: BufferNewPush, value: number): void {
  if (buffer.pushes >= buffer.size) {
    const old = buffer.vals[buffer.index];
    if (old !== undefined) {
      buffer.sum -= old;
    }
  }

  buffer.sum += value;
  buffer.vals[buffer.index] = value;
  buffer.pushes += 1;
  buffer.index += 1;
  if (buffer.index >= buffer.size) {
    buffer.index = 0;
  }
}

/**
 * 根据典型价与成交量计算 MFI 序列：正向/负向资金流用环形窗口累加，窗口满后输出 (up/(up+down))*100。
 *
 * @param high 最高价数组
 * @param low 最低价数组
 * @param close 收盘价数组
 * @param volume 成交量数组
 * @param period MFI 周期
 * @param size 实际参与计算的长度，默认 full length
 * @returns MFI 值序列（0–100）
 */
function calculateMfiSeries(
  high: ReadonlyArray<number>,
  low: ReadonlyArray<number>,
  close: ReadonlyArray<number>,
  volume: ReadonlyArray<number>,
  period: number,
  size: number = high.length,
): number[] {
  if (size <= period) {
    return [];
  }

  const firstHigh = high[0];
  const firstLow = low[0];
  const firstClose = close[0];
  if (
    firstHigh === undefined ||
    firstLow === undefined ||
    firstClose === undefined ||
    !Number.isFinite(firstHigh) ||
    !Number.isFinite(firstLow) ||
    !Number.isFinite(firstClose)
  ) {
    return [];
  }

  const output: number[] = [];
  let previousTypicalPrice = (firstHigh + firstLow + firstClose) / 3;

  const up: BufferNewPush = {
    size: period,
    index: 0,
    pushes: 0,
    sum: 0,
    vals: [],
  };

  const down: BufferNewPush = {
    size: period,
    index: 0,
    pushes: 0,
    sum: 0,
    vals: [],
  };

  for (let i = 1; i < size; i += 1) {
    const currentHigh = high[i];
    const currentLow = low[i];
    const currentClose = close[i];
    const currentVolume = volume[i];
    if (
      currentHigh === undefined ||
      currentLow === undefined ||
      currentClose === undefined ||
      currentVolume === undefined ||
      !Number.isFinite(currentHigh) ||
      !Number.isFinite(currentLow) ||
      !Number.isFinite(currentClose) ||
      !Number.isFinite(currentVolume)
    ) {
      break;
    }

    const typicalPrice = (currentHigh + currentLow + currentClose) / 3;
    const bar = typicalPrice * currentVolume;

    if (typicalPrice > previousTypicalPrice) {
      pushBuffer(up, bar);
      pushBuffer(down, 0);
    } else if (typicalPrice < previousTypicalPrice) {
      pushBuffer(down, bar);
      pushBuffer(up, 0);
    } else {
      pushBuffer(up, 0);
      pushBuffer(down, 0);
    }

    previousTypicalPrice = typicalPrice;

    if (i >= period) {
      output.push((up.sum / (up.sum + down.sum)) * 100);
    }
  }

  return output;
}

/**
 * 在 calculateMfiSeries 结果上对每个值保留两位小数，满足技术指标展示精度。
 * @param high - 最高价数组
 * @param low - 最低价数组
 * @param close - 收盘价数组
 * @param volume - 成交量数组
 * @param period - MFI 周期
 * @returns 保留两位小数的 MFI 值序列（0–100）
 */
function calculateMfiSeriesWithTechnicalPrecision(
  high: ReadonlyArray<number>,
  low: ReadonlyArray<number>,
  close: ReadonlyArray<number>,
  volume: ReadonlyArray<number>,
  period: number,
): number[] {
  const result = calculateMfiSeries(high, low, close, volume, period);
  return result.map((value) => roundToFixed2(value));
}

/**
 * 计算 MFI（资金流量指标）
 * @param candles K线数据数组
 * @param period MFI周期，默认14
 * @returns MFI值（0-100），如果无法计算则返回null
 */
export function calculateMFI(
  candles: ReadonlyArray<CandleData>,
  period: number = 14,
): number | null {
  if (!candles || candles.length < period + 1) {
    return null;
  }

  try {
    // 优化：一次遍历完成数据提取、验证和构建（原来需要9次遍历）
    const validHighs: number[] = [];
    const validLows: number[] = [];
    const mfiCloses: number[] = [];
    const validVolumes: number[] = [];

    for (const candle of candles) {
      const high = toNumber(candle.high);
      const low = toNumber(candle.low);
      const close = toNumber(candle.close);
      const volume = toNumber(candle.volume ?? 0);

      // 边提取边验证
      if (
        isValidPositiveNumber(high) &&
        isValidPositiveNumber(low) &&
        isValidPositiveNumber(close) &&
        Number.isFinite(volume) &&
        volume >= 0
      ) {
        validHighs.push(high);
        validLows.push(low);
        mfiCloses.push(close);
        validVolumes.push(volume);
      }
    }

    const minRequired = period + 1;
    if (validHighs.length < minRequired) {
      return null;
    }

    const mfiResult = calculateMfiSeriesWithTechnicalPrecision(
      validHighs,
      validLows,
      mfiCloses,
      validVolumes,
      period,
    );

    if (!mfiResult || mfiResult.length === 0) {
      return null;
    }

    const mfi = mfiResult.at(-1);

    if (mfi === undefined || !validatePercentage(mfi)) {
      return null;
    }

    return mfi;
  } catch (err) {
    logDebug(`MFI计算失败 (period=${period})`, err);
    return null;
  }
}

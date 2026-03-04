/**
 * MFI（资金流量指标）计算模块
 *
 * 指标参数：
 * - MFI：周期 14，结合价格和成交量
 */
import { isValidPositiveNumber } from '../../utils/helpers/index.js';
import { toNumber, logDebug, roundToFixed2, validatePercentage } from './utils.js';
import type { CandleData } from '../../types/data.js';
import type { BufferNewPush } from './types.js';

/**
 * 向环形缓冲区追加一个值，满窗时覆盖最旧项并更新 sum（O(1) 滑动窗口）。
 *
 * @param buffer 环形缓冲区（含 size、pushes、sum、data）
 * @param value 待追加的数值
 * @returns 无返回值（原地更新 buffer）
 */
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
 * 根据典型价与成交量流式推进窗口，仅保留最后一个 MFI 原始值。
 *
 * @param high 最高价数组
 * @param low 最低价数组
 * @param close 收盘价数组
 * @param volume 成交量数组
 * @param period MFI 周期
 * @param size 实际参与计算的长度，默认 full length
 * @returns 最后一个 MFI 原始值（未 round），无法计算时返回 null
 */
function calculateLatestMfiRawValue(
  high: ReadonlyArray<number>,
  low: ReadonlyArray<number>,
  close: ReadonlyArray<number>,
  volume: ReadonlyArray<number>,
  period: number,
  size: number = high.length,
): number | null {
  if (size <= period) {
    return null;
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
    return null;
  }

  let lastRawMfi: number | null = null;
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
      lastRawMfi = (up.sum / (up.sum + down.sum)) * 100;
    }
  }

  return lastRawMfi;
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
  if (candles.length < period + 1) {
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

    const latestRawMfi = calculateLatestMfiRawValue(
      validHighs,
      validLows,
      mfiCloses,
      validVolumes,
      period,
    );
    if (latestRawMfi === null) {
      return null;
    }

    const mfi = roundToFixed2(latestRawMfi);
    if (!validatePercentage(mfi)) {
      return null;
    }

    return mfi;
  } catch (err) {
    logDebug(`MFI计算失败 (period=${period})`, err);
    return null;
  }
}

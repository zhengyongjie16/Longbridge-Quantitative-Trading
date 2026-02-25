import type { Candlestick } from 'longport';
import { decimalToNumber, toHongKongTimeLog } from '../../src/utils/helpers/index.js';
import { calculateEMA } from '../../src/services/indicators/ema.js';
import { calculateKDJ } from '../../src/services/indicators/kdj.js';
import { calculateMFI } from '../../src/services/indicators/mfi.js';
import { calculateRSI } from '../../src/services/indicators/rsi.js';
import type { CandleData } from '../../src/types/data.js';
import type {
  CandleNumbers,
  ComputeMinuteRowsOptions,
  ComputeMinuteRowsResult,
  LastCandleVariant,
  MinuteIndicatorRow,
  RowColorCondition,
  RowColorConditionSet,
  RowColorIndicatorKey,
  RowColorMode,
  VPResult,
} from './types.js';

const ROW_COLOR_KEYS: ReadonlyArray<RowColorIndicatorKey> = [
  'rsi6',
  'k',
  'd',
  'j',
  'mfi',
  'adx',
  'ema5',
  'poc',
  'vah',
  'val',
  'vaPositionInValueArea',
];

/**
 * 判断值是否包含 `toNumber` 方法。默认行为：仅对象且方法存在时返回 true。
 *
 * @param value 待判断值
 * @returns 是否为可调用 `toNumber` 的对象
 */
function hasToNumberMethod(value: unknown): value is { readonly toNumber: () => number } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return 'toNumber' in value && typeof value.toNumber === 'function';
}

/**
 * 将未知输入转换为 number。默认行为：无法解析时返回 `NaN`。
 *
 * @param value 待转换值
 * @returns 转换后的 number
 */
function toNumberFromUnknown(value: unknown): number {
  if (value === null || value === undefined) {
    return Number.NaN;
  }
  if (typeof value === 'number' || typeof value === 'string') {
    return Number(value);
  }
  if (hasToNumberMethod(value)) {
    return decimalToNumber(value);
  }
  return Number.NaN;
}

/**
 * 将 LongPort K 线转换为项目 CandleData。默认行为：所有字段尽力转 number。
 *
 * @param candlestick LongPort K 线
 * @returns CandleData 对象
 */
export function toCandle(candlestick: Candlestick): CandleData {
  return {
    high: toNumberFromUnknown(candlestick.high),
    low: toNumberFromUnknown(candlestick.low),
    close: toNumberFromUnknown(candlestick.close),
    open: toNumberFromUnknown(candlestick.open),
    volume: toNumberFromUnknown(candlestick.volume),
  };
}

/**
 * 将 CandleData 转为已校验的 OHLCV 数值结构。默认行为：存在无效字段时返回 null。
 *
 * @param candle CandleData 对象
 * @returns 有效数值 K 线或 null
 */
function parseCandleNumbers(candle: CandleData): CandleNumbers | null {
  const open = toNumberFromUnknown(candle.open);
  const high = toNumberFromUnknown(candle.high);
  const low = toNumberFromUnknown(candle.low);
  const close = toNumberFromUnknown(candle.close);
  const volume = toNumberFromUnknown(candle.volume);

  if (
    !Number.isFinite(open) ||
    !Number.isFinite(high) ||
    !Number.isFinite(low) ||
    !Number.isFinite(close) ||
    !Number.isFinite(volume)
  ) {
    return null;
  }

  return {
    open,
    high,
    low,
    close,
    volume,
  };
}

/**
 * 计算 ADX（平均趋向指数）。默认行为：数据不足返回 null。
 *
 * @param candles K 线数组
 * @param period ADX 周期
 * @returns ADX 值（0-100）或 null
 */
export function calculateADX(candles: ReadonlyArray<CandleData>, period: number): number | null {
  if (candles.length < 2 * period + 1) {
    return null;
  }

  const highs: number[] = [];
  const lows: number[] = [];
  const closes: number[] = [];

  for (const candle of candles) {
    const parsed = parseCandleNumbers(candle);
    if (parsed === null) {
      return null;
    }
    highs.push(parsed.high);
    lows.push(parsed.low);
    closes.push(parsed.close);
  }

  let atr = 0;
  let plusDm = 0;
  let minusDm = 0;

  for (let i = 1; i <= period; i += 1) {
    const high = highs[i];
    const low = lows[i];
    const prevHigh = highs[i - 1];
    const prevLow = lows[i - 1];
    const prevClose = closes[i - 1];
    if (
      high === undefined ||
      low === undefined ||
      prevHigh === undefined ||
      prevLow === undefined ||
      prevClose === undefined
    ) {
      return null;
    }

    const trueRange = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose),
    );
    const upMove = high - prevHigh;
    const downMove = prevLow - low;
    atr += trueRange;
    plusDm += upMove > downMove && upMove > 0 ? upMove : 0;
    minusDm += downMove > upMove && downMove > 0 ? downMove : 0;
  }

  const dxValues: number[] = [];

  for (let i = period + 1; i < candles.length; i += 1) {
    const high = highs[i];
    const low = lows[i];
    const prevHigh = highs[i - 1];
    const prevLow = lows[i - 1];
    const prevClose = closes[i - 1];
    if (
      high === undefined ||
      low === undefined ||
      prevHigh === undefined ||
      prevLow === undefined ||
      prevClose === undefined
    ) {
      return null;
    }

    const trueRange = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose),
    );
    const upMove = high - prevHigh;
    const downMove = prevLow - low;

    atr = atr - atr / period + trueRange;
    plusDm = plusDm - plusDm / period + (upMove > downMove && upMove > 0 ? upMove : 0);
    minusDm = minusDm - minusDm / period + (downMove > upMove && downMove > 0 ? downMove : 0);

    if (atr === 0) {
      dxValues.push(0);
      continue;
    }

    const plusDi = (plusDm / atr) * 100;
    const minusDi = (minusDm / atr) * 100;
    const diSum = plusDi + minusDi;
    const dx = diSum === 0 ? 0 : (Math.abs(plusDi - minusDi) / diSum) * 100;
    dxValues.push(dx);
  }

  if (dxValues.length < period) {
    return null;
  }

  let adx = 0;
  for (let i = 0; i < period; i += 1) {
    const dx = dxValues[i];
    if (dx === undefined) {
      return null;
    }
    adx += dx;
  }
  adx /= period;

  for (let i = period; i < dxValues.length; i += 1) {
    const dx = dxValues[i];
    if (dx === undefined) {
      return null;
    }
    adx = (adx * (period - 1) + dx) / period;
  }

  return Number.parseFloat(adx.toFixed(2));
}

/**
 * 计算 VP（Volume Profile）。默认行为：输入无效或总量为 0 时返回 null。
 *
 * @param candles K 线数组
 * @param vaPercent 价值区域比例
 * @param numBins 价格分桶数量
 * @returns VP 结果或 null
 */
export function calculateVP(
  candles: ReadonlyArray<CandleData>,
  vaPercent: number,
  numBins: number,
): VPResult | null {
  if (candles.length === 0 || numBins < 1) {
    return null;
  }

  let minPrice = Number.POSITIVE_INFINITY;
  let maxPrice = Number.NEGATIVE_INFINITY;

  for (const candle of candles) {
    const parsed = parseCandleNumbers(candle);
    if (parsed === null) {
      continue;
    }
    if (parsed.low < minPrice) {
      minPrice = parsed.low;
    }
    if (parsed.high > maxPrice) {
      maxPrice = parsed.high;
    }
  }

  if (!Number.isFinite(minPrice) || !Number.isFinite(maxPrice) || maxPrice < minPrice) {
    return null;
  }

  const binSize = maxPrice > minPrice ? (maxPrice - minPrice) / numBins : 0;
  const bins = new Array<number>(numBins).fill(0);

  for (const candle of candles) {
    const parsed = parseCandleNumbers(candle);
    if (parsed === null || parsed.volume < 0) {
      continue;
    }

    const typicalPrice = (parsed.high + parsed.low + parsed.close) / 3;
    const index =
      binSize <= 0 ? 0 : Math.max(0, Math.min(numBins - 1, Math.floor((typicalPrice - minPrice) / binSize)));
    const current = bins[index];
    if (current === undefined) {
      continue;
    }
    bins[index] = current + parsed.volume;
  }

  const totalVol = bins.reduce((sum, value) => sum + value, 0);
  if (totalVol <= 0) {
    return null;
  }

  let pocBin = 0;
  for (let i = 1; i < numBins; i += 1) {
    const current = bins[i];
    const poc = bins[pocBin];
    if (current === undefined || poc === undefined) {
      continue;
    }
    if (current > poc) {
      pocBin = i;
    }
  }

  const targetVol = totalVol * vaPercent;
  let lowBin = pocBin;
  let highBin = pocBin;
  let valueAreaVol = bins[pocBin] ?? 0;

  while (valueAreaVol < targetVol) {
    const volAbove = highBin + 1 < numBins ? (bins[highBin + 1] ?? 0) : 0;
    const volBelow = lowBin - 1 >= 0 ? (bins[lowBin - 1] ?? 0) : 0;
    if (volAbove === 0 && volBelow === 0) {
      break;
    }
    if (volAbove >= volBelow) {
      highBin += 1;
      valueAreaVol += volAbove;
      continue;
    }
    lowBin -= 1;
    valueAreaVol += volBelow;
  }

  const poc = binSize > 0 ? minPrice + (pocBin + 0.5) * binSize : minPrice;
  const val = binSize > 0 ? minPrice + lowBin * binSize : minPrice;
  const vah = binSize > 0 ? minPrice + (highBin + 1) * binSize : maxPrice;

  return {
    poc: Number.parseFloat(poc.toFixed(3)),
    vah: Number.parseFloat(vah.toFixed(3)),
    val: Number.parseFloat(val.toFixed(3)),
  };
}

/**
 * 计算字符串显示宽度。默认行为：ASCII 按 1、非 ASCII 按 2。
 *
 * @param text 输入文本
 * @returns 显示宽度
 */
export function getDisplayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    width += code > 127 ? 2 : 1;
  }
  return width;
}

/**
 * 按显示宽度补齐空格。默认行为：当前宽度已满足时原样返回。
 *
 * @param text 输入文本
 * @param targetWidth 目标显示宽度
 * @returns 补齐后的文本
 */
export function padToDisplayWidth(text: string, targetWidth: number): string {
  const current = getDisplayWidth(text);
  if (current >= targetWidth) {
    return text;
  }
  return text + ' '.repeat(targetWidth - current);
}

/**
 * 格式化指标值。默认行为：无效值返回 `-`。
 *
 * @param value 指标值
 * @param decimals 小数位数
 * @returns 格式化文本
 */
export function formatMetricValue(value: number | null | undefined, decimals: number = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '-';
  }
  return value.toFixed(decimals);
}

/**
 * 格式化涨幅文本。默认行为：无效值返回 `-`。
 *
 * @param value 涨幅百分比值
 * @returns 形如 `+1.23%` 的文本
 */
export function formatChangePercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '-';
  }
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

/**
 * 将日期转换为港股日期字符串。默认行为：按 UTC+8 计算。
 *
 * @param date 日期对象
 * @returns `YYYY-MM-DD`
 */
export function toHKDateStr(date: Date): string {
  const hongKongDate = new Date(date.getTime() + 8 * 3600 * 1000);
  const year = hongKongDate.getUTCFullYear();
  const month = String(hongKongDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(hongKongDate.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 计算价格在价值区域中的相对位置。默认行为：VP 无效或范围为 0 时返回 null。
 *
 * @param price 当前价格
 * @param vp VP 结果
 * @returns VA 区间归一化位置或 null
 */
function computeVAPosition(price: number, vp: VPResult | null): number | null {
  if (vp === null || !Number.isFinite(vp.vah) || !Number.isFinite(vp.val) || vp.vah === vp.val) {
    return null;
  }
  return Number.isFinite(price) ? (price - vp.val) / (vp.vah - vp.val) : null;
}

/**
 * 根据配置键读取一行中的指标值。默认行为：无匹配或无效值时返回 null。
 *
 * @param row 分钟指标行
 * @param key 指标键
 * @returns 指标数值或 null
 */
export function getIndicatorValue(
  row: MinuteIndicatorRow,
  key: RowColorIndicatorKey,
): number | null {
  switch (key) {
    case 'rsi6':
      return row.rsi6 !== null && Number.isFinite(row.rsi6) ? row.rsi6 : null;
    case 'k':
      return row.kdj !== null && Number.isFinite(row.kdj.k) ? row.kdj.k : null;
    case 'd':
      return row.kdj !== null && Number.isFinite(row.kdj.d) ? row.kdj.d : null;
    case 'j':
      return row.kdj !== null && Number.isFinite(row.kdj.j) ? row.kdj.j : null;
    case 'mfi':
      return row.mfi !== null && Number.isFinite(row.mfi) ? row.mfi : null;
    case 'adx':
      return row.adx !== null && Number.isFinite(row.adx) ? row.adx : null;
    case 'ema5':
      return row.ema5 !== null && Number.isFinite(row.ema5) ? row.ema5 : null;
    case 'poc':
      return row.vp !== null && Number.isFinite(row.vp.poc) ? row.vp.poc : null;
    case 'vah':
      return row.vp !== null && Number.isFinite(row.vp.vah) ? row.vp.vah : null;
    case 'val':
      return row.vp !== null && Number.isFinite(row.vp.val) ? row.vp.val : null;
    case 'vaPositionInValueArea':
      return row.vaPositionInValueArea !== null && Number.isFinite(row.vaPositionInValueArea)
        ? row.vaPositionInValueArea
        : null;
    default:
      return null;
  }

  return null;
}

/**
 * 判断单条条件是否命中。默认行为：空条件返回 false。
 *
 * @param row 分钟指标行
 * @param condition 单条条件
 * @param mode 着色模式
 * @returns 是否满足该条件
 */
export function rowMatchesOneCondition(
  row: MinuteIndicatorRow,
  condition: RowColorCondition,
  mode: RowColorMode,
): boolean {
  let hasConfiguredThreshold = false;

  for (const key of ROW_COLOR_KEYS) {
    const threshold = condition[key];
    if (threshold === undefined) {
      continue;
    }
    if (!Number.isFinite(threshold)) {
      continue;
    }

    hasConfiguredThreshold = true;
    const value = getIndicatorValue(row, key);
    if (value === null) {
      return false;
    }

    if (mode === 'green' && value >= threshold) {
      return false;
    }
    if (mode === 'red' && value <= threshold) {
      return false;
    }
  }

  return hasConfiguredThreshold;
}

/**
 * 判断是否命中任意条件。默认行为：条件集为空时返回 false。
 *
 * @param row 分钟指标行
 * @param conditionSet 多条件集合
 * @param mode 着色模式
 * @returns 是否满足任一条件
 */
export function rowMatchesAnyCondition(
  row: MinuteIndicatorRow,
  conditionSet: RowColorConditionSet,
  mode: RowColorMode,
): boolean {
  for (const condition of conditionSet) {
    if (rowMatchesOneCondition(row, condition, mode)) {
      return true;
    }
  }
  return false;
}

/**
 * 计算分钟指标行（每分钟高/低各一条）。默认行为：当日数据不存在时返回空数组。
 *
 * @param allCandles 全量分钟 K 线（含预热历史）
 * @param options 指标计算参数
 * @returns 当日分钟指标行与日期
 */
export function computeMinuteRows(
  allCandles: ReadonlyArray<Candlestick>,
  options: ComputeMinuteRowsOptions,
): ComputeMinuteRowsResult {
  if (allCandles.length === 0) {
    return { rows: [], todayDate: '' };
  }

  const lastCandle = allCandles[allCandles.length - 1];
  if (lastCandle === undefined) {
    return { rows: [], todayDate: '' };
  }

  const todayDate = toHKDateStr(lastCandle.timestamp);
  const todayStartIndex = allCandles.findIndex((candlestick) => toHKDateStr(candlestick.timestamp) === todayDate);
  if (todayStartIndex < 0) {
    return { rows: [], todayDate };
  }

  const allCandleData = allCandles.map(toCandle);
  const prevDayCandle = todayStartIndex > 0 ? allCandleData[todayStartIndex - 1] : null;
  const prevDayClose =
    prevDayCandle === null || prevDayCandle === undefined
      ? null
      : toNumberFromUnknown(prevDayCandle.close);

  const rows: MinuteIndicatorRow[] = [];

  for (let index = todayStartIndex; index < allCandles.length; index += 1) {
    const rawCandle = allCandles[index];
    const candleData = allCandleData[index];
    if (rawCandle === undefined || candleData === undefined) {
      continue;
    }

    const parsed = parseCandleNumbers(candleData);
    if (parsed === null) {
      continue;
    }

    const previousCandles = allCandleData.slice(0, index);
    const highVariantCandle: CandleData = {
      open: parsed.open,
      high: parsed.high,
      low: parsed.low,
      close: parsed.high,
      volume: parsed.volume,
    };
    const lowVariantCandle: CandleData = {
      open: parsed.open,
      high: parsed.high,
      low: parsed.low,
      close: parsed.low,
      volume: parsed.volume,
    };

    const highCandles: ReadonlyArray<CandleData> = [...previousCandles, highVariantCandle];
    const lowCandles: ReadonlyArray<CandleData> = [...previousCandles, lowVariantCandle];

    const vpHigh = calculateVP(highCandles, options.vpVaPercent, options.vpBins);
    const vpLow = calculateVP(lowCandles, options.vpVaPercent, options.vpBins);
    const vaPositionHigh = computeVAPosition(parsed.high, vpHigh);
    const vaPositionLow = computeVAPosition(parsed.low, vpLow);

    const changePercent =
      prevDayClose !== null && Number.isFinite(prevDayClose) && prevDayClose !== 0
        ? ((parsed.close - prevDayClose) / prevDayClose) * 100
        : null;

    const hongKongTime = toHongKongTimeLog(rawCandle.timestamp);
    const baseTime = hongKongTime.split('.')[0];
    const time = baseTime ?? hongKongTime;

    const rowHigh: MinuteIndicatorRow = {
      time,
      variant: 'high',
      open: parsed.open,
      high: parsed.high,
      low: parsed.low,
      close: parsed.close,
      changePercent,
      volume: parsed.volume,
      ema5: calculateEMA(highCandles, options.ema5Period),
      rsi6: calculateRSI(highCandles, options.rsiPeriod),
      kdj: calculateKDJ(highCandles, options.kdjPeriod),
      mfi: calculateMFI(highCandles, options.mfiPeriod),
      adx: calculateADX(highCandles, options.adxPeriod),
      vp: vpHigh,
      vaPositionInValueArea: vaPositionHigh,
    };
    const rowLow: MinuteIndicatorRow = {
      time,
      variant: 'low',
      open: parsed.open,
      high: parsed.high,
      low: parsed.low,
      close: parsed.close,
      changePercent,
      volume: parsed.volume,
      ema5: calculateEMA(lowCandles, options.ema5Period),
      rsi6: calculateRSI(lowCandles, options.rsiPeriod),
      kdj: calculateKDJ(lowCandles, options.kdjPeriod),
      mfi: calculateMFI(lowCandles, options.mfiPeriod),
      adx: calculateADX(lowCandles, options.adxPeriod),
      vp: vpLow,
      vaPositionInValueArea: vaPositionLow,
    };

    rows.push(rowHigh, rowLow);
  }

  return { rows, todayDate };
}

/**
 * 生成时间列文本。默认行为：附加「高/低」标签。
 *
 * @param time 时间文本
 * @param variant 末根变体
 * @returns 组合后的时间列文本
 */
export function formatTimeWithVariant(time: string, variant: LastCandleVariant): string {
  const label = variant === 'high' ? '高' : '低';
  return `${time} ${label}`;
}

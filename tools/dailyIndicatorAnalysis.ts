/**
 * 分钟级价格与技术指标查询工具
 *
 * 功能：
 * - 获取指定标的当日分钟级 K 线数据（最近 1000 根）
 * - 计算每分钟的 EMA5、RSI6、KDJ、MFI、ADX 指标
 * - 计算每分钟的 VP（Volume Profile）：POC、VAH、VAL
 * - 按时间顺序输出每分钟的收盘价、涨幅（相对昨日收盘）、成交量与指标值（不显示开盘/最高/最低）
 * - 每分钟指标计算两次：最后一根 K 线分别用「最高价」和「最低价」作为收盘参与计算，输出两行（高/低），红绿条件对每行独立判断，任一行满足即标对应颜色
 *
 * VP 说明：
 * - POC (Price of Control)：成交量最大的价格水平
 * - VA (Value Area)：包含总成交量一定比例（默认 70%）的价格区域
 * - VAH/VAL (Value Area High/Low)：价值区域的最高价/最低价
 *
 * 运行方式：
 * bun tools/dailyIndicatorAnalysis.ts [标的代码]
 *
 * 示例：
 * bun tools/dailyIndicatorAnalysis.ts 700.HK
 *
 * 配置参数：
 * - DEFAULT_SYMBOL：默认标的代码
 * - CANDLE_COUNT：获取的 K 线数量（覆盖当日 + 前一日用于指标预热）
 * - VP_VA_PERCENT：价值区域占比（0~1，默认 0.7）
 * - VP_BINS：价格分档数量，用于构建成交量分布
 * - GREEN_CONDITIONS：多条件数组，满足其中任意一条（该条内所有指标 < 阈值）即整行标绿
 * - RED_CONDITIONS：多条件数组，满足其中任意一条（该条内所有指标 > 阈值）即整行标红
 */
import dotenv from 'dotenv';
import { QuoteContext, Period, AdjustType, TradeSessions } from 'longport';
import { createConfig } from '../src/config/config.index.js';
import { decimalToNumber, formatNumber, toHongKongTimeLog } from '../src/utils/helpers/index.js';
import { calculateRSI } from '../src/services/indicators/rsi.js';
import { calculateKDJ } from '../src/services/indicators/kdj.js';
import { calculateMFI } from '../src/services/indicators/mfi.js';
import { calculateEMA } from '../src/services/indicators/ema.js';
import type { CandleData } from '../src/types/data.js';

dotenv.config({ path: '.env.local' });

// ============================================
// 配置变量（可直接修改）
// ============================================

/** 默认查询标的代码 */
const DEFAULT_SYMBOL = 'HSI.HK';

/** 获取 K 线数量（覆盖当日全天 + 前一日用于指标预热） */
const CANDLE_COUNT = 1000;

/** RSI 周期 */
const RSI_PERIOD = 6;

/** KDJ RSV 周期 */
const KDJ_PERIOD = 9;

/** MFI 周期 */
const MFI_PERIOD = 14;

/** ADX 周期 */
const ADX_PERIOD = 14;

/** EMA5 周期 */
const EMA5_PERIOD = 5;

/** VP 价值区域占比（0~1，通常 70%） */
const VP_VA_PERCENT = 0.7;

/** VP 价格分档数量，用于构建成交量分布 */
const VP_BINS = 80;

/**
 * 单条行着色条件：键为指标名，值为阈值。
 * 绿色：该条内所有配置指标「小于」阈值时满足；红色：该条内所有配置指标「大于」阈值时满足。
 * 可选键：rsi6, k, d, j, mfi, adx, ema5, poc, vah, val, vaPositionInValueArea
 */
type RowColorCondition = Readonly<Record<string, number>>;

/**
 * 多条件：满足其中任意一条即标对应颜色。
 * 例如 [{ rsi6: 20, k: 20 }, { k: 15 }] 表示「rsi6<20 且 k<20」或「k<15」任一成立即标绿。
 */
type RowColorConditionSet = ReadonlyArray<RowColorCondition>;

/** 绿色多条件：满足任意一条（该条内所有指标 < 阈值）即标绿 */
const GREEN_CONDITIONS: RowColorConditionSet = [
  { rsi6: 20, d: 20, j: 0, vaPositionInValueArea: 0.6 },
  { j: -10 },
];

/** 红色多条件：满足任意一条（该条内所有指标 > 阈值）即标红 */
const RED_CONDITIONS: RowColorConditionSet = [
  { rsi6: 80, d: 80, j: 100, vaPositionInValueArea: 0.8 },
  { j: 110 },
];

// ============================================

/**
 * 原始 K 线数据类型（兼容 SDK 返回）
 */
type RawCandlestick = {
  readonly timestamp: Date;
  readonly open: unknown;
  readonly high: unknown;
  readonly low: unknown;
  readonly close: unknown;
  readonly volume: unknown;
  readonly turnover?: unknown;
};

type DecimalInput = string | number | null;

/** VP（Volume Profile）结果：POC、价值区域上下沿 */
type VPResult = {
  readonly poc: number;
  readonly vah: number;
  readonly val: number;
};

/** 指标计算采用的最后一根 K 线价格：高 = 用最高价，低 = 用最低价 */
type LastCandleVariant = 'high' | 'low';

/**
 * 单分钟指标结果（每分钟产生两条：高/低各一）
 */
type MinuteIndicatorRow = {
  readonly time: string;
  readonly variant: LastCandleVariant;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  /** 涨幅（%），相对昨日收盘价 */
  readonly changePercent: number | null;
  readonly volume: number;
  readonly ema5: number | null;
  readonly rsi6: number | null;
  readonly kdj: { k: number; d: number; j: number } | null;
  readonly mfi: number | null;
  readonly adx: number | null;
  readonly vp: VPResult | null;
  /** 当前价在 VA 区间中的相对位置（高行用最高价，低行用最低价） */
  readonly vaPositionInValueArea: number | null;
};

/**
 * 将原始 K 线转换为 CandleData
 */
function toCandle(c: RawCandlestick): CandleData {
  return {
    high: decimalToNumber(c.high as DecimalInput),
    low: decimalToNumber(c.low as DecimalInput),
    close: decimalToNumber(c.close as DecimalInput),
    open: decimalToNumber(c.open as DecimalInput),
    volume: decimalToNumber(c.volume as DecimalInput),
  };
}

/**
 * 计算 ADX（平均趋向指数）
 *
 * 算法：
 * 1. TR = max(H-L, |H-prevC|, |L-prevC|)
 * 2. +DM = H-prevH > prevL-L && H-prevH > 0 ? H-prevH : 0
 * 3. -DM = prevL-L > H-prevH && prevL-L > 0 ? prevL-L : 0
 * 4. 用 Wilder 平滑（周期 period）计算 ATR、+DI、-DI
 * 5. DX = |+DI - -DI| / (+DI + -DI) * 100
 * 6. ADX = Wilder 平滑 DX（周期 period）
 *
 * @param candles K 线数组
 * @param period ADX 周期，默认 14
 * @returns ADX 值（0-100），数据不足时返回 null
 */
function calculateADX(candles: ReadonlyArray<CandleData>, period: number = 14): number | null {
  if (candles.length < 2 * period + 1) {
    return null;
  }

  const highs: number[] = [];
  const lows: number[] = [];
  const closes: number[] = [];

  for (const c of candles) {
    const h = typeof c.high === 'number' ? c.high : Number(c.high);
    const l = typeof c.low === 'number' ? c.low : Number(c.low);
    const cl = typeof c.close === 'number' ? c.close : Number(c.close);
    if (!Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(cl)) {
      return null;
    }
    highs.push(h);
    lows.push(l);
    closes.push(cl);
  }

  // seed 阶段：前 period 根 K 线累加 TR/+DM/-DM
  let atr14 = 0;
  let plusDm14 = 0;
  let minusDm14 = 0;

  for (let i = 1; i <= period; i += 1) {
    const h = highs[i]!;
    const l = lows[i]!;
    const prevH = highs[i - 1]!;
    const prevL = lows[i - 1]!;
    const prevC = closes[i - 1]!;
    const tr = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
    const upMove = h - prevH;
    const downMove = prevL - l;
    atr14 += tr;
    plusDm14 += upMove > downMove && upMove > 0 ? upMove : 0;
    minusDm14 += downMove > upMove && downMove > 0 ? downMove : 0;
  }

  // Wilder 平滑阶段，收集 DX 值
  const dxValues: number[] = [];

  for (let i = period + 1; i < candles.length; i += 1) {
    const h = highs[i]!;
    const l = lows[i]!;
    const prevH = highs[i - 1]!;
    const prevL = lows[i - 1]!;
    const prevC = closes[i - 1]!;
    const tr = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
    const upMove = h - prevH;
    const downMove = prevL - l;

    atr14 = atr14 - atr14 / period + tr;
    plusDm14 = plusDm14 - plusDm14 / period + (upMove > downMove && upMove > 0 ? upMove : 0);
    minusDm14 = minusDm14 - minusDm14 / period + (downMove > upMove && downMove > 0 ? downMove : 0);

    if (atr14 === 0) {
      dxValues.push(0);
      continue;
    }

    const plusDi = (plusDm14 / atr14) * 100;
    const minusDi = (minusDm14 / atr14) * 100;
    const diSum = plusDi + minusDi;
    dxValues.push(diSum === 0 ? 0 : (Math.abs(plusDi - minusDi) / diSum) * 100);
  }

  if (dxValues.length < period) {
    return null;
  }

  // seed ADX，再 Wilder 平滑
  let adx = 0;
  for (let i = 0; i < period; i += 1) {
    adx += dxValues[i]!;
  }
  adx /= period;

  for (let i = period; i < dxValues.length; i += 1) {
    adx = (adx * (period - 1) + dxValues[i]!) / period;
  }

  return Number.parseFloat(adx.toFixed(2));
}

/**
 * 计算 VP（Volume Profile）：POC、VA、VAH、VAL
 *
 * 算法：
 * 1. 按典型价 (H+L+C)/3 将每根 K 线的成交量归入价格分档（bins）
 * 2. POC：成交量最大的分档对应的价格（取分档中心）
 * 3. VA：从 POC 向上下扩展，每次加入相邻成交量较大的一侧，直到累计成交量达到总成交量的 VP_VA_PERCENT
 * 4. VAH/VAL：价值区域的最高价/最低价（分档边界）
 *
 * @param candles K 线数组（通常为当日开盘至当前分钟的累计）
 * @param vaPercent 价值区域占比，默认 0.7
 * @param numBins 价格分档数，默认 VP_BINS
 * @returns POC、VAH、VAL，数据不足或无成交量时返回 null
 */
function calculateVP(
  candles: ReadonlyArray<CandleData>,
  vaPercent: number = VP_VA_PERCENT,
  numBins: number = VP_BINS,
): VPResult | null {
  if (candles.length === 0 || numBins < 1) return null;

  let minPrice = Infinity;
  let maxPrice = -Infinity;

  for (const c of candles) {
    const h = typeof c.high === 'number' ? c.high : Number(c.high);
    const l = typeof c.low === 'number' ? c.low : Number(c.low);
    const cl = typeof c.close === 'number' ? c.close : Number(c.close);
    if (!Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(cl)) continue;
    if (l < minPrice) minPrice = l;
    if (h > maxPrice) maxPrice = h;
  }

  if (!Number.isFinite(minPrice) || !Number.isFinite(maxPrice) || maxPrice < minPrice) {
    return null;
  }

  const binSize = maxPrice > minPrice ? (maxPrice - minPrice) / numBins : 0;
  const bins = new Array<number>(numBins).fill(0);

  for (const c of candles) {
    const h = typeof c.high === 'number' ? c.high : Number(c.high);
    const l = typeof c.low === 'number' ? c.low : Number(c.low);
    const cl = typeof c.close === 'number' ? c.close : Number(c.close);
    const v = typeof c.volume === 'number' ? c.volume : Number(c.volume);
    if (
      !Number.isFinite(h) ||
      !Number.isFinite(l) ||
      !Number.isFinite(cl) ||
      !Number.isFinite(v) ||
      v < 0
    ) {
      continue;
    }
    const typicalPrice = (h + l + cl) / 3;
    let binIdx: number;
    if (binSize <= 0) {
      binIdx = 0;
    } else {
      binIdx = Math.floor((typicalPrice - minPrice) / binSize);
      if (binIdx >= numBins) binIdx = numBins - 1;
      if (binIdx < 0) binIdx = 0;
    }
    const existing = bins[binIdx] ?? 0;
    bins[binIdx] = existing + v;
  }

  const totalVol = bins.reduce((a, b) => a + b, 0);
  if (totalVol <= 0) return null;

  let pocBinIdx = 0;
  for (let i = 1; i < numBins; i += 1) {
    if (bins[i]! > bins[pocBinIdx]!) pocBinIdx = i;
  }

  const targetVol = vaPercent * totalVol;
  let lowBin = pocBinIdx;
  let highBin = pocBinIdx;
  let vaVol = bins[pocBinIdx]!;

  while (vaVol < targetVol) {
    const volAbove = highBin + 1 < numBins ? bins[highBin + 1]! : 0;
    const volBelow = lowBin - 1 >= 0 ? bins[lowBin - 1]! : 0;
    if (volAbove === 0 && volBelow === 0) break;
    if (volAbove >= volBelow) {
      highBin += 1;
      vaVol += volAbove;
    } else {
      lowBin -= 1;
      vaVol += volBelow;
    }
  }

  const poc = binSize > 0 ? minPrice + (pocBinIdx + 0.5) * binSize : minPrice;
  const val = binSize > 0 ? minPrice + lowBin * binSize : minPrice;
  const vah = binSize > 0 ? minPrice + (highBin + 1) * binSize : maxPrice;

  return {
    poc: Number.parseFloat(poc.toFixed(3)),
    vah: Number.parseFloat(vah.toFixed(3)),
    val: Number.parseFloat(val.toFixed(3)),
  };
}

/**
 * 字符串在终端中的显示宽度：ASCII 等半角为 1，中文等全角为 2
 */
function getDisplayWidth(s: string): number {
  let w = 0;
  for (const c of s) {
    const code = c.codePointAt(0) ?? 0;
    w += code > 127 ? 2 : 1;
  }
  return w;
}

/**
 * 按显示宽度右补空格至目标宽度，使表头与数据列视觉对齐（中文占 2 格）
 */
function padToDisplayWidth(s: string, targetWidth: number): string {
  const current = getDisplayWidth(s);
  if (current >= targetWidth) return s;
  return s + ' '.repeat(targetWidth - current);
}

/**
 * 格式化指标值，无效时显示 -
 */
function fmt(value: number | null | undefined, decimals: number = 2): string {
  if (value == null || !Number.isFinite(value)) return '-';
  return value.toFixed(decimals);
}

/** 格式化涨幅列：无效显示 -，否则显示 +x.xx% 或 -x.xx%（不含填充，由调用方按显示宽度对齐） */
function formatChangePercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

/** 从行数据中按配置键取指标数值，键未支持或无效时返回 null */
function getIndicatorValue(row: MinuteIndicatorRow, key: string): number | null {
  const v = (() => {
    switch (key) {
      case 'rsi6':
        return row.rsi6;
      case 'k':
        return row.kdj?.k ?? null;
      case 'd':
        return row.kdj?.d ?? null;
      case 'j':
        return row.kdj?.j ?? null;
      case 'mfi':
        return row.mfi;
      case 'adx':
        return row.adx;
      case 'ema5':
        return row.ema5;
      case 'poc':
        return row.vp?.poc ?? null;
      case 'vah':
        return row.vp?.vah ?? null;
      case 'val':
        return row.vp?.val ?? null;
      case 'vaPositionInValueArea':
        return row.vaPositionInValueArea;
      default:
        return null;
    }
  })();
  return v != null && Number.isFinite(v) ? v : null;
}

/**
 * 判断行是否满足单条条件：该条内所有键在行上均有有效值，且绿色为全小于阈值、红色为全大于阈值。
 */
function rowMatchesOneCondition(
  row: MinuteIndicatorRow,
  condition: RowColorCondition,
  mode: 'green' | 'red',
): boolean {
  const keys = Object.keys(condition);
  if (keys.length === 0) return false;

  for (const key of keys) {
    const threshold = condition[key];
    if (threshold == null || !Number.isFinite(threshold)) continue;

    const value = getIndicatorValue(row, key);
    if (value === null) return false;

    if (mode === 'green' && value >= threshold) return false;
    if (mode === 'red' && value <= threshold) return false;
  }
  return true;
}

/** 判断行是否满足多条件中的任意一条 */
function rowMatchesAnyCondition(
  row: MinuteIndicatorRow,
  conditionSet: RowColorConditionSet,
  mode: 'green' | 'red',
): boolean {
  return conditionSet.some((cond) => rowMatchesOneCondition(row, cond, mode));
}

const ANSI_RESET = '\x1b[0m';
const ANSI_GREEN = '\x1b[32m';
const ANSI_RED = '\x1b[31m';

/**
 * 获取港股日期字符串（YYYY-MM-DD）
 */
function toHKDateStr(date: Date): string {
  const hk = new Date(date.getTime() + 8 * 3600 * 1000);
  const y = hk.getUTCFullYear();
  const m = String(hk.getUTCMonth() + 1).padStart(2, '0');
  const d = String(hk.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 计算每分钟的指标，仅输出当日 K 线行，前缀历史 K 线用于指标预热
 */
function computeMinuteRows(allCandles: RawCandlestick[]): {
  rows: MinuteIndicatorRow[];
  todayDate: string;
} {
  if (allCandles.length === 0) return { rows: [], todayDate: '' };

  // 取最后一根 K 线的港股日期作为"今日"
  const lastCandle = allCandles.at(-1)!;
  const todayDate = toHKDateStr(lastCandle.timestamp);

  // 找到今日第一根 K 线的索引
  const todayStartIdx = allCandles.findIndex((c) => toHKDateStr(c.timestamp) === todayDate);
  if (todayStartIdx === -1) return { rows: [], todayDate };

  const allCandleData = allCandles.map(toCandle);
  const prevDayCandle = todayStartIdx > 0 ? allCandleData[todayStartIdx - 1] : null;
  let prevDayClose: number | null = null;
  if (prevDayCandle != null) {
    const c = prevDayCandle.close;
    prevDayClose = typeof c === 'number' ? c : Number(c);
  }
  const hasValidPrevClose =
    prevDayClose != null && Number.isFinite(prevDayClose) && prevDayClose !== 0;

  const rows: MinuteIndicatorRow[] = [];

  for (let i = todayStartIdx; i < allCandles.length; i += 1) {
    const raw = allCandles[i]!;
    const candle = allCandleData[i]!;
    const open = typeof candle.open === 'number' ? candle.open : Number(candle.open);
    const high = typeof candle.high === 'number' ? candle.high : Number(candle.high);
    const low = typeof candle.low === 'number' ? candle.low : Number(candle.low);
    const close = typeof candle.close === 'number' ? candle.close : Number(candle.close);
    const volume = typeof candle.volume === 'number' ? candle.volume : Number(candle.volume);

    const prevCandles = allCandleData.slice(0, i);
    const lastCandleHigh: CandleData = { open, high, low, close: high, volume };
    const lastCandleLow: CandleData = { open, high, low, close: low, volume };
    const combinedHigh: ReadonlyArray<CandleData> = [...prevCandles, lastCandleHigh];
    const combinedLow: ReadonlyArray<CandleData> = [...prevCandles, lastCandleLow];

    const vpHigh = calculateVP(combinedHigh);
    const vpLow = calculateVP(combinedLow);
    let vaPosHigh: number | null = null;
    let vaPosLow: number | null = null;
    if (
      vpHigh &&
      Number.isFinite(vpHigh.vah) &&
      Number.isFinite(vpHigh.val) &&
      vpHigh.vah !== vpHigh.val
    ) {
      vaPosHigh = Number.isFinite(high) ? (high - vpHigh.val) / (vpHigh.vah - vpHigh.val) : null;
    }
    if (
      vpLow &&
      Number.isFinite(vpLow.vah) &&
      Number.isFinite(vpLow.val) &&
      vpLow.vah !== vpLow.val
    ) {
      vaPosLow = Number.isFinite(low) ? (low - vpLow.val) / (vpLow.vah - vpLow.val) : null;
    }

    const base = prevDayClose;
    const changePercent =
      hasValidPrevClose && base != null && Number.isFinite(close)
        ? ((close - base) / base) * 100
        : null;

    const timeStr = toHongKongTimeLog(raw.timestamp).split('.')[0];
    const time = timeStr ?? toHongKongTimeLog(raw.timestamp);

    const rowHigh: MinuteIndicatorRow = {
      time,
      variant: 'high',
      open,
      high,
      low,
      close,
      changePercent,
      volume,
      ema5: calculateEMA(combinedHigh, EMA5_PERIOD),
      rsi6: calculateRSI(combinedHigh, RSI_PERIOD),
      kdj: calculateKDJ(combinedHigh, KDJ_PERIOD),
      mfi: calculateMFI(combinedHigh, MFI_PERIOD),
      adx: calculateADX(combinedHigh, ADX_PERIOD),
      vp: vpHigh,
      vaPositionInValueArea: vaPosHigh,
    };
    const rowLow: MinuteIndicatorRow = {
      time,
      variant: 'low',
      open,
      high,
      low,
      close,
      changePercent,
      volume,
      ema5: calculateEMA(combinedLow, EMA5_PERIOD),
      rsi6: calculateRSI(combinedLow, RSI_PERIOD),
      kdj: calculateKDJ(combinedLow, KDJ_PERIOD),
      mfi: calculateMFI(combinedLow, MFI_PERIOD),
      adx: calculateADX(combinedLow, ADX_PERIOD),
      vp: vpLow,
      vaPositionInValueArea: vaPosLow,
    };
    rows.push(rowHigh, rowLow);
  }

  return { rows, todayDate };
}

/** 时间列显示：时间 + 高/低（不含填充，由调用方按显示宽度对齐） */
function formatTimeWithVariant(time: string, variant: LastCandleVariant): string {
  const label = variant === 'high' ? '高' : '低';
  return `${time} ${label}`;
}

/**
 * 输出表格（每分钟两行：高/低，每行独立着色）
 */
function displayRows(rows: MinuteIndicatorRow[], symbol: string, date: string): void {
  const minuteCount = rows.length / 2;
  console.log(
    `\n标的: ${symbol}  日期: ${date}  共 ${minuteCount} 分钟（每分高/低两行，共 ${rows.length} 条）\n`,
  );

  const colWidths = [30, 10, 10, 15, 10, 7, 7, 7, 7, 7, 7, 12, 12, 12, 12] as const;
  const headerCells = [
    padToDisplayWidth('时间', colWidths[0]),
    padToDisplayWidth('收盘', colWidths[1]),
    padToDisplayWidth('涨幅%', colWidths[2]),
    padToDisplayWidth('成交量', colWidths[3]),
    padToDisplayWidth('EMA5', colWidths[4]),
    padToDisplayWidth('RSI6', colWidths[5]),
    padToDisplayWidth('K', colWidths[6]),
    padToDisplayWidth('D', colWidths[7]),
    padToDisplayWidth('J', colWidths[8]),
    padToDisplayWidth('MFI', colWidths[9]),
    padToDisplayWidth('ADX', colWidths[10]),
    padToDisplayWidth('POC', colWidths[11]),
    padToDisplayWidth('VAH', colWidths[12]),
    padToDisplayWidth('VAL', colWidths[13]),
    padToDisplayWidth('VA_POS', colWidths[14]),
  ];
  const header = '|' + headerCells.join('|') + '|';
  const separator = '|' + colWidths.map((w) => '-'.repeat(w)).join('|') + '|';

  console.log(header);
  console.log(separator);

  for (const row of rows) {
    const lineCells = [
      padToDisplayWidth(formatTimeWithVariant(row.time, row.variant), colWidths[0]),
      padToDisplayWidth(formatNumber(row.close, 3), colWidths[1]),
      padToDisplayWidth(formatChangePercent(row.changePercent), colWidths[2]),
      padToDisplayWidth(String(Math.round(row.volume)), colWidths[3]),
      padToDisplayWidth(fmt(row.ema5), colWidths[4]),
      padToDisplayWidth(fmt(row.rsi6), colWidths[5]),
      padToDisplayWidth(fmt(row.kdj?.k), colWidths[6]),
      padToDisplayWidth(fmt(row.kdj?.d), colWidths[7]),
      padToDisplayWidth(fmt(row.kdj?.j), colWidths[8]),
      padToDisplayWidth(fmt(row.mfi), colWidths[9]),
      padToDisplayWidth(fmt(row.adx), colWidths[10]),
      padToDisplayWidth(row.vp ? formatNumber(row.vp.poc, 3) : '-', colWidths[11]),
      padToDisplayWidth(row.vp ? formatNumber(row.vp.vah, 3) : '-', colWidths[12]),
      padToDisplayWidth(row.vp ? formatNumber(row.vp.val, 3) : '-', colWidths[13]),
      padToDisplayWidth(fmt(row.vaPositionInValueArea), colWidths[14]),
    ];
    const line = '|' + lineCells.join('|') + '|';

    const green = rowMatchesAnyCondition(row, GREEN_CONDITIONS, 'green');
    const red = rowMatchesAnyCondition(row, RED_CONDITIONS, 'red');
    let prefix = '';
    if (green) prefix = ANSI_GREEN;
    else if (red) prefix = ANSI_RED;
    const suffix = green || red ? ANSI_RESET : '';
    console.log(prefix + line + suffix);
    if (row.variant === 'low') console.log('');
  }
}

async function main(): Promise<void> {
  const symbol = process.argv[2] || DEFAULT_SYMBOL;

  console.log(`查询标的: ${symbol}`);
  console.log('正在获取数据...');

  const config = createConfig({ env: process.env });
  const ctx = await QuoteContext.new(config);

  const raw = await ctx.candlesticks(
    symbol,
    Period.Min_1,
    CANDLE_COUNT,
    AdjustType.NoAdjust,
    TradeSessions.Intraday,
  );

  if (raw.length === 0) {
    console.log('未获取到分钟 K 线数据');
    return;
  }

  console.log(`获取到 ${raw.length} 根 K 线`);

  const { rows, todayDate } = computeMinuteRows(raw as RawCandlestick[]);

  if (rows.length === 0) {
    console.log('未找到当日 K 线数据');
    return;
  }

  displayRows(rows, symbol, todayDate);
}

try {
  await main();
} catch (error: unknown) {
  console.error('程序执行失败:', error);
  process.exit(1);
}

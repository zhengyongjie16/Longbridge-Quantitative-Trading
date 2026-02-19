/**
 * 分钟级价格与技术指标查询工具
 *
 * 功能：
 * - 获取指定标的当日分钟级 K 线数据（最近 1000 根）
 * - 计算每分钟的 RSI6、KDJ、MFI、ADX 指标
 * - 按时间顺序输出每分钟的价格与指标值
 *
 * 运行方式：
 * bun tools/minuteIndicatorQuery.ts [标的代码]
 *
 * 示例：
 * bun tools/minuteIndicatorQuery.ts 700.HK
 *
 * 配置参数：
 * - DEFAULT_SYMBOL：默认标的代码
 * - CANDLE_COUNT：获取的 K 线数量（覆盖当日 + 前一日用于指标预热）
 */
import dotenv from 'dotenv';
import { QuoteContext, Period, AdjustType, TradeSessions } from 'longport';
import { createConfig } from '../src/config/config.index.js';
import { decimalToNumber, formatNumber, toHongKongTimeLog } from '../src/utils/helpers/index.js';
import { calculateRSI } from '../src/services/indicators/rsi.js';
import { calculateKDJ } from '../src/services/indicators/kdj.js';
import { calculateMFI } from '../src/services/indicators/mfi.js';
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

/**
 * 单分钟指标结果
 */
type MinuteIndicatorRow = {
  readonly time: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly rsi6: number | null;
  readonly kdj: { k: number; d: number; j: number } | null;
  readonly mfi: number | null;
  readonly adx: number | null;
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
 * 格式化指标值，无效时显示 -
 */
function fmt(value: number | null | undefined, decimals: number = 2): string {
  if (value == null || !Number.isFinite(value)) return '-';
  return value.toFixed(decimals);
}

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
function computeMinuteRows(allCandles: RawCandlestick[]): { rows: MinuteIndicatorRow[]; todayDate: string } {
  if (allCandles.length === 0) return { rows: [], todayDate: '' };

  // 取最后一根 K 线的港股日期作为"今日"
  const lastCandle = allCandles.at(-1)!;
  const todayDate = toHKDateStr(lastCandle.timestamp);

  // 找到今日第一根 K 线的索引
  const todayStartIdx = allCandles.findIndex((c) => toHKDateStr(c.timestamp) === todayDate);
  if (todayStartIdx === -1) return { rows: [], todayDate };

  const allCandleData = allCandles.map(toCandle);
  const rows: MinuteIndicatorRow[] = [];

  for (let i = todayStartIdx; i < allCandles.length; i += 1) {
    const raw = allCandles[i]!;
    const candle = allCandleData[i]!;
    // 截至当前分钟的全部 K 线（含预热数据）
    const combined = allCandleData.slice(0, i + 1);

    rows.push({
      time: toHongKongTimeLog(raw.timestamp).split('.')[0]!,
      open: typeof candle.open === 'number' ? candle.open : Number(candle.open),
      high: typeof candle.high === 'number' ? candle.high : Number(candle.high),
      low: typeof candle.low === 'number' ? candle.low : Number(candle.low),
      close: typeof candle.close === 'number' ? candle.close : Number(candle.close),
      volume: typeof candle.volume === 'number' ? candle.volume : Number(candle.volume),
      rsi6: calculateRSI(combined, RSI_PERIOD),
      kdj: calculateKDJ(combined, KDJ_PERIOD),
      mfi: calculateMFI(combined, MFI_PERIOD),
      adx: calculateADX(combined, ADX_PERIOD),
    });
  }

  return { rows, todayDate };
}

/**
 * 输出表格
 */
function displayRows(rows: MinuteIndicatorRow[], symbol: string, date: string): void {
  console.log(`\n标的: ${symbol}  日期: ${date}  共 ${rows.length} 根分钟 K 线\n`);

  const header = [
    '时间'.padEnd(20),
    '开盘'.padStart(8),
    '最高'.padStart(8),
    '最低'.padStart(8),
    '收盘'.padStart(8),
    '成交量'.padStart(12),
    'RSI6'.padStart(7),
    'K'.padStart(7),
    'D'.padStart(7),
    'J'.padStart(7),
    'MFI'.padStart(7),
    'ADX'.padStart(7),
  ].join('  ');

  console.log(header);
  console.log('-'.repeat(header.length));

  for (const row of rows) {
    const line = [
      row.time.padEnd(20),
      formatNumber(row.open, 3).padStart(8),
      formatNumber(row.high, 3).padStart(8),
      formatNumber(row.low, 3).padStart(8),
      formatNumber(row.close, 3).padStart(8),
      String(Math.round(row.volume)).padStart(12),
      fmt(row.rsi6).padStart(7),
      fmt(row.kdj?.k).padStart(7),
      fmt(row.kdj?.d).padStart(7),
      fmt(row.kdj?.j).padStart(7),
      fmt(row.mfi).padStart(7),
      fmt(row.adx).padStart(7),
    ].join('  ');
    console.log(line);
  }
}

async function main(): Promise<void> {
  const symbol = process.argv[2] || DEFAULT_SYMBOL;

  console.log(`查询标的: ${symbol}`);
  console.log('正在获取数据...');

  const config = createConfig({ env: process.env });
  const ctx = await QuoteContext.new(config);

  const raw = await ctx.candlesticks(symbol, Period.Min_1, CANDLE_COUNT, AdjustType.NoAdjust, TradeSessions.Intraday);

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

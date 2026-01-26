/**
 * 日级K线实时监控工具
 *
 * 功能：
 * - 每秒实时获取日级K线数据
 * - 计算所有技术指标（RSI、KDJ、MACD、MFI、EMA）
 * - 参考主程序显示逻辑，实时显示监控结果
 *
 * 运行方式：
 * npm run monitor-daily
 *
 * 配置参数：
 * - DEFAULT_SYMBOL：监控标的（默认 HSI.HK）
 * - RSI_PERIODS：RSI周期数组
 * - EMA_PERIODS：EMA周期数组
 */

import dotenv from 'dotenv';
import { QuoteContext, Period, AdjustType, TradeSessions } from 'longport';
import { buildIndicatorSnapshot } from '../src/services/indicators/index.js';
import { createConfig } from '../src/config/config.index.js';
import {
  decimalToNumber,
  formatNumber,
  sleep,
  toBeijingTimeLog,
} from '../src/utils/helpers/index.js';
import { isValidNumber } from '../src/utils/helpers/indicatorHelpers.js';
import type { CandleData, IndicatorSnapshot, Quote } from '../src/types/index.js';

dotenv.config({ path: '.env.local' });

// ============================================
// 配置变量（可直接修改）
// ============================================

/** 默认监控标的代码 */
const DEFAULT_SYMBOL = 'HSI.HK';

/** RSI 周期数组 */
const RSI_PERIODS = [6, 12];

/** EMA 周期数组 */
const EMA_PERIODS = [5];

/** 刷新间隔（毫秒） */
const REFRESH_INTERVAL_MS = 1000;

/** 日级K线获取数量 */
const DAILY_CANDLE_COUNT = 100;

/** 变化检测阈值 */
const CHANGE_THRESHOLD = 0.001;

// ============================================

/**
 * K线原始数据类型
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

/**
 * 监控状态类型
 */
type MonitorState = {
  lastPrice: number | null;
  lastChangePercent: number | null;
  lastEma: Record<number, number> | null;
  lastRsi: Record<number, number> | null;
  lastMfi: number | null;
  lastKdj: { k: number; d: number; j: number } | null;
  lastMacd: { macd: number; dif: number; dea: number } | null;
};

/**
 * 监控上下文类型
 */
type MonitorContext = {
  readonly ctx: QuoteContext;
  readonly monitorSymbol: string;
  readonly state: MonitorState;
};

/**
 * 格式化K线时间戳为日志前缀（仅显示时分秒）
 */
function formatKlineTimePrefix(timestamp: number | null | undefined): string {
  if (timestamp && Number.isFinite(timestamp)) {
    const timeStr = toBeijingTimeLog(new Date(timestamp));
    return `[K线时间: ${timeStr.split(' ')[1]}] `;
  }
  return '';
}

/**
 * 格式化指标值
 */
function formatIndicator(value: number | null | undefined, decimals: number = 3): string {
  if (isValidNumber(value)) {
    return value.toFixed(decimals);
  }
  return '-';
}

/**
 * 检测值是否发生变化
 */
function hasChanged(current: number | null | undefined, last: number | null | undefined, threshold: number): boolean {
  if (current == null || last == null) return current !== last;
  if (!Number.isFinite(current) || !Number.isFinite(last)) return false;
  return Math.abs(current - last) > threshold;
}

/**
 * 将原始K线数据转换为 CandleData 类型
 */
function convertToCandleData(candles: readonly RawCandlestick[]): CandleData[] {
  return candles.map((c) => ({
    high: decimalToNumber(c.high as string | number | null),
    low: decimalToNumber(c.low as string | number | null),
    close: decimalToNumber(c.close as string | number | null),
    open: decimalToNumber(c.open as string | number | null),
    volume: decimalToNumber(c.volume as string | number | null),
  }));
}

/**
 * 获取日级K线数据
 */
async function getDailyCandles(
  ctx: QuoteContext,
  symbol: string,
  count: number = DAILY_CANDLE_COUNT,
): Promise<CandleData[]> {
  const candles = await ctx.candlesticks(
    symbol,
    Period.Day,
    count,
    AdjustType.NoAdjust,
    TradeSessions.All,
  );
  return convertToCandleData(candles as readonly RawCandlestick[]);
}

/**
 * 获取标的实时行情
 */
async function getQuote(ctx: QuoteContext, symbol: string): Promise<Quote | null> {
  const quotes = await ctx.quote([symbol]);
  const quote = quotes[0];
  if (!quote) return null;

  return {
    symbol,
    name: quote.symbol ?? null,
    price: decimalToNumber(quote.lastDone),
    prevClose: decimalToNumber(quote.prevClose),
    timestamp: quote.timestamp.getTime(),
  };
}

/**
 * 检测指标是否有变化
 */
function detectIndicatorChanges(
  snapshot: IndicatorSnapshot,
  quote: Quote | null,
  state: MonitorState,
): boolean {
  const currentPrice = snapshot.price;

  // 计算涨跌幅
  const prevClose = quote?.prevClose ?? null;
  let changePercent: number | null = null;
  if (Number.isFinite(currentPrice) && currentPrice > 0 && Number.isFinite(prevClose) && prevClose !== null && prevClose > 0) {
    changePercent = ((currentPrice - prevClose) / prevClose) * 100;
  }

  // 检查价格变化
  if (state.lastPrice == null || hasChanged(currentPrice, state.lastPrice, CHANGE_THRESHOLD)) {
    return true;
  }

  // 检查涨跌幅变化
  if (changePercent !== null && (state.lastChangePercent == null || hasChanged(changePercent, state.lastChangePercent, 0.01))) {
    return true;
  }

  // 检查 EMA 变化
  if (snapshot.ema) {
    for (const period of EMA_PERIODS) {
      const currentEma = snapshot.ema[period];
      const lastEma = state.lastEma?.[period];
      if (Number.isFinite(currentEma) && (lastEma == null || hasChanged(currentEma, lastEma, CHANGE_THRESHOLD))) {
        return true;
      }
    }
  }

  // 检查 RSI 变化
  if (snapshot.rsi) {
    for (const period of RSI_PERIODS) {
      const currentRsi = snapshot.rsi[period];
      const lastRsi = state.lastRsi?.[period];
      if (Number.isFinite(currentRsi) && (lastRsi == null || hasChanged(currentRsi, lastRsi, CHANGE_THRESHOLD))) {
        return true;
      }
    }
  }

  // 检查 MFI 变化
  if (Number.isFinite(snapshot.mfi) && (state.lastMfi == null || hasChanged(snapshot.mfi, state.lastMfi, CHANGE_THRESHOLD))) {
    return true;
  }

  // 检查 KDJ 变化
  if (snapshot.kdj) {
    const { k, d, j } = snapshot.kdj;
    if (
      (Number.isFinite(k) && (state.lastKdj?.k == null || hasChanged(k, state.lastKdj.k, CHANGE_THRESHOLD))) ||
      (Number.isFinite(d) && (state.lastKdj?.d == null || hasChanged(d, state.lastKdj.d, CHANGE_THRESHOLD))) ||
      (Number.isFinite(j) && (state.lastKdj?.j == null || hasChanged(j, state.lastKdj.j, CHANGE_THRESHOLD)))
    ) {
      return true;
    }
  }

  // 检查 MACD 变化
  if (snapshot.macd) {
    const { macd, dif, dea } = snapshot.macd;
    if (
      (Number.isFinite(macd) && (state.lastMacd?.macd == null || hasChanged(macd, state.lastMacd.macd, CHANGE_THRESHOLD))) ||
      (Number.isFinite(dif) && (state.lastMacd?.dif == null || hasChanged(dif, state.lastMacd.dif, CHANGE_THRESHOLD))) ||
      (Number.isFinite(dea) && (state.lastMacd?.dea == null || hasChanged(dea, state.lastMacd.dea, CHANGE_THRESHOLD)))
    ) {
      return true;
    }
  }

  return false;
}

/**
 * 更新监控状态
 */
function updateState(snapshot: IndicatorSnapshot, quote: Quote | null, state: MonitorState): void {
  state.lastPrice = snapshot.price;

  // 计算涨跌幅
  const prevClose = quote?.prevClose ?? null;
  if (Number.isFinite(snapshot.price) && snapshot.price > 0 && Number.isFinite(prevClose) && prevClose !== null && prevClose > 0) {
    state.lastChangePercent = ((snapshot.price - prevClose) / prevClose) * 100;
  }

  // 更新 EMA
  if (snapshot.ema) {
    state.lastEma = { ...snapshot.ema };
  }

  // 更新 RSI
  if (snapshot.rsi) {
    state.lastRsi = { ...snapshot.rsi };
  }

  // 更新 MFI
  state.lastMfi = snapshot.mfi;

  // 更新 KDJ
  if (snapshot.kdj) {
    state.lastKdj = { k: snapshot.kdj.k, d: snapshot.kdj.d, j: snapshot.kdj.j };
  }

  // 更新 MACD
  if (snapshot.macd) {
    state.lastMacd = { macd: snapshot.macd.macd, dif: snapshot.macd.dif, dea: snapshot.macd.dea };
  }
}

/**
 * 显示监控标的的所有指标（参考主程序 marketMonitor 的显示逻辑）
 */
function displayIndicators(
  snapshot: IndicatorSnapshot,
  quote: Quote | null,
  monitorSymbol: string,
): void {
  const currentPrice = snapshot.price;

  // 计算涨跌幅
  const prevClose = quote?.prevClose ?? null;
  let changePercent: number | null = null;
  if (Number.isFinite(currentPrice) && currentPrice > 0 && Number.isFinite(prevClose) && prevClose !== null && prevClose > 0) {
    changePercent = ((currentPrice - prevClose) / prevClose) * 100;
  }

  // 构建指标显示字符串（按照主程序顺序：最新价、涨跌幅、EMAn、RSIn、MFI、K、D、J、MACD、DIF、DEA）
  const indicators: string[] = [];

  // 1. 最新价
  if (Number.isFinite(currentPrice)) {
    indicators.push(`价格=${formatNumber(currentPrice, 3)}`);
  }

  // 2. 涨跌幅
  if (changePercent !== null) {
    const sign = changePercent >= 0 ? '+' : '';
    indicators.push(`涨跌幅=${sign}${formatNumber(changePercent, 2)}%`);
  }

  // 3. EMAn
  if (snapshot.ema) {
    for (const period of EMA_PERIODS) {
      const value = snapshot.ema[period];
      if (typeof value === 'number' && Number.isFinite(value)) {
        indicators.push(`EMA${period}=${formatIndicator(value, 3)}`);
      }
    }
  }

  // 4. RSIn
  if (snapshot.rsi) {
    for (const period of RSI_PERIODS) {
      const value = snapshot.rsi[period];
      if (typeof value === 'number' && Number.isFinite(value)) {
        indicators.push(`RSI${period}=${formatIndicator(value, 3)}`);
      }
    }
  }

  // 5. MFI
  if (Number.isFinite(snapshot.mfi)) {
    indicators.push(`MFI=${formatIndicator(snapshot.mfi, 3)}`);
  }

  // 6. KDJ
  if (snapshot.kdj) {
    const { k, d, j } = snapshot.kdj;
    if (Number.isFinite(k)) indicators.push(`K=${formatIndicator(k, 3)}`);
    if (Number.isFinite(d)) indicators.push(`D=${formatIndicator(d, 3)}`);
    if (Number.isFinite(j)) indicators.push(`J=${formatIndicator(j, 3)}`);
  }

  // 7. MACD
  if (snapshot.macd) {
    const { macd, dif, dea } = snapshot.macd;
    if (Number.isFinite(macd)) indicators.push(`MACD=${formatIndicator(macd, 3)}`);
    if (Number.isFinite(dif)) indicators.push(`DIF=${formatIndicator(dif, 3)}`);
    if (Number.isFinite(dea)) indicators.push(`DEA=${formatIndicator(dea, 3)}`);
  }

  const symbolName = quote?.name ?? monitorSymbol;
  const timePrefix = formatKlineTimePrefix(quote?.timestamp);

  console.log(`${timePrefix}[监控标的] ${symbolName}(${monitorSymbol}) ${indicators.join(' ')}`);
}

/**
 * 执行单次监控循环
 */
async function runMonitorCycle(context: MonitorContext): Promise<void> {
  const { ctx, monitorSymbol, state } = context;

  // 并发获取数据
  const [dailyCandles, monitorQuote] = await Promise.all([
    getDailyCandles(ctx, monitorSymbol),
    getQuote(ctx, monitorSymbol),
  ]);

  // 计算指标
  const snapshot = dailyCandles.length > 0
    ? buildIndicatorSnapshot(monitorSymbol, dailyCandles, RSI_PERIODS, EMA_PERIODS)
    : null;

  if (!snapshot) {
    return;
  }

  // 检测变化
  const hasChange = detectIndicatorChanges(snapshot, monitorQuote, state);

  // 只在有变化时显示
  if (hasChange) {
    displayIndicators(snapshot, monitorQuote, monitorSymbol);
    updateState(snapshot, monitorQuote, state);
  }
}

/**
 * 创建监控上下文
 */
async function createMonitorContext(monitorSymbol: string): Promise<MonitorContext> {
  const env = process.env;
  const config = createConfig({ env });
  const ctx = await QuoteContext.new(config);

  return {
    ctx,
    monitorSymbol,
    state: {
      lastPrice: null,
      lastChangePercent: null,
      lastEma: null,
      lastRsi: null,
      lastMfi: null,
      lastKdj: null,
      lastMacd: null,
    },
  };
}

/**
 * 主函数
 */
async function main(): Promise<void> {
  const monitorSymbol = process.argv[2] || process.env['DAILY_MONITOR_SYMBOL'] || DEFAULT_SYMBOL;

  console.log(`正在初始化日级K线实时监控...`);
  console.log(`监控标的: ${monitorSymbol}`);
  console.log('');

  const context = await createMonitorContext(monitorSymbol);

  console.log('初始化完成，开始监控（按 Ctrl+C 退出）...\n');

  // 注册退出处理
  let isRunning = true;

  const handleExit = (): void => {
    isRunning = false;
    console.log('\n正在退出...');
    process.exit(0);
  };

  process.on('SIGINT', handleExit);
  process.on('SIGTERM', handleExit);

  // 主循环
  while (isRunning) {
    try {
      await runMonitorCycle(context);
    } catch (err) {
      console.error('监控循环发生错误:', (err as Error).message || err);
    }

    await sleep(REFRESH_INTERVAL_MS);
  }
}

// 运行主函数
try {
  await main();
} catch (error: unknown) {
  console.error('程序执行失败:', error);
  process.exit(1);
}

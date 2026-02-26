/**
 * 日级 K 线实时监控工具。
 * 职责：每秒拉取日线数据并计算指标，只在指标发生变化时输出。
 * 流程：初始化上下文 -> 轮询行情与 K 线 -> 变化检测 -> 条件输出。
 */
import dotenv from 'dotenv';
import { AdjustType, Period, QuoteContext, TradeSessions } from 'longport';
import { createConfig } from '../../src/config/config.index.js';
import { buildIndicatorSnapshot } from '../../src/services/indicators/utils.js';
import { decimalToNumber, sleep } from '../../src/utils/helpers/index.js';
import type { CandleData } from '../../src/types/data.js';
import type { Quote } from '../../src/types/quote.js';
import type { ChangeDetectConfig, IndicatorPeriods, MonitorContext } from './types.js';
import {
  convertToCandleData,
  createInitialState,
  detectIndicatorChanges,
  displayIndicators,
  updateState,
} from './utils.js';

dotenv.config({ path: '.env.local' });

/** 默认监控标的代码 */
const DEFAULT_SYMBOL = 'HSI.HK';

/** RSI 周期数组 */
const RSI_PERIODS = [6, 12] as const;

/** EMA 周期数组 */
const EMA_PERIODS = [5] as const;

/** 刷新间隔（毫秒） */
const REFRESH_INTERVAL_MS = 1000;

/** 日级 K 线获取数量 */
const DAILY_CANDLE_COUNT = 100;

/** 变化检测阈值 */
const CHANGE_THRESHOLD = 0.001;

const INDICATOR_PERIODS: IndicatorPeriods = {
  emaPeriods: EMA_PERIODS,
  rsiPeriods: RSI_PERIODS,
};

const CHANGE_DETECT_CONFIG: ChangeDetectConfig = {
  changeThreshold: CHANGE_THRESHOLD,
  indicatorPeriods: INDICATOR_PERIODS,
};

/**
 * 获取日级 K 线并转换为 CandleData。
 *
 * @param ctx 行情上下文
 * @param symbol 标的代码
 * @param count 获取数量
 * @returns 日级 K 线数组
 */
async function getDailyCandles(
  ctx: QuoteContext,
  symbol: string,
  count: number = DAILY_CANDLE_COUNT,
): Promise<ReadonlyArray<CandleData>> {
  const candles = await ctx.candlesticks(
    symbol,
    Period.Day,
    count,
    AdjustType.NoAdjust,
    TradeSessions.All,
  );
  return convertToCandleData(candles);
}

/**
 * 获取标的实时行情。
 *
 * @param ctx 行情上下文
 * @param symbol 标的代码
 * @returns 行情对象或 null
 */
async function getQuote(ctx: QuoteContext, symbol: string): Promise<Quote | null> {
  const quotes = await ctx.quote([symbol]);
  const quote = quotes[0];
  if (quote === undefined) {
    return null;
  }

  return {
    symbol,
    name: quote.symbol,
    price: decimalToNumber(quote.lastDone),
    prevClose: decimalToNumber(quote.prevClose),
    timestamp: quote.timestamp.getTime(),
  };
}

/**
 * 执行单次监控循环：并发拉取数据、计算指标、变化检测并按需输出。
 *
 * @param context 监控上下文
 * @param detectConfig 变化检测配置
 * @returns 无返回值
 */
async function runMonitorCycle(
  context: MonitorContext,
  detectConfig: ChangeDetectConfig,
): Promise<void> {
  const [dailyCandles, monitorQuote] = await Promise.all([
    getDailyCandles(context.ctx, context.monitorSymbol),
    getQuote(context.ctx, context.monitorSymbol),
  ]);

  const snapshot =
    dailyCandles.length > 0
      ? buildIndicatorSnapshot(
          context.monitorSymbol,
          dailyCandles,
          detectConfig.indicatorPeriods.rsiPeriods,
          detectConfig.indicatorPeriods.emaPeriods,
        )
      : null;
  if (snapshot === null) {
    return;
  }

  const hasChange = detectIndicatorChanges(snapshot, monitorQuote, context.state, detectConfig);
  if (!hasChange) {
    return;
  }

  displayIndicators({
    snapshot,
    quote: monitorQuote,
    monitorSymbol: context.monitorSymbol,
    indicatorPeriods: detectConfig.indicatorPeriods,
  });
  updateState(snapshot, monitorQuote, context.state);
}

/**
 * 创建监控上下文（初始化 LongPort QuoteContext 与状态）。
 *
 * @param monitorSymbol 监控标的代码
 * @returns 监控上下文
 */
async function createMonitorContext(monitorSymbol: string): Promise<MonitorContext> {
  const config = createConfig({ env: process.env });
  const ctx = await QuoteContext.new(config);

  return {
    ctx,
    monitorSymbol,
    state: createInitialState(),
  };
}

async function main(): Promise<void> {
  const monitorSymbol = process.argv[2] ?? process.env['DAILY_MONITOR_SYMBOL'] ?? DEFAULT_SYMBOL;

  console.log('正在初始化日级K线实时监控...');
  console.log(`监控标的: ${monitorSymbol}`);
  console.log('');

  const context = await createMonitorContext(monitorSymbol);
  console.log('初始化完成，开始监控（按 Ctrl+C 退出）...\n');

  const handleExit = (): void => {
    console.log('\n正在退出...');
    process.exit(0);
  };

  process.on('SIGINT', handleExit);
  process.on('SIGTERM', handleExit);

  for (;;) {
    try {
      await runMonitorCycle(context, CHANGE_DETECT_CONFIG);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`监控循环发生错误: ${message}`);
    }

    await sleep(REFRESH_INTERVAL_MS);
  }
}

try {
  await main();
} catch (error: unknown) {
  console.error('程序执行失败:', error);
  process.exit(1);
}

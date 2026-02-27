/**
 * 分钟级价格与技术指标查询工具。
 * 职责：拉取当日分钟 K 线，计算 EMA/RSI/KDJ/MFI/ADX 与 VP，并输出终端表格。
 * 流程：读取参数 -> 获取分钟 K 线 -> 计算高/低双行指标 -> 按条件着色输出。
 */
import dotenv from 'dotenv';
import { AdjustType, Period, QuoteContext, TradeSessions } from 'longport';
import { createConfig } from '../../src/config/config.index.js';
import type {
  ComputeMinuteRowsOptions,
  MinuteIndicatorRow,
  RowColorConditionSet,
} from './types.js';
import {
  computeMinuteRows,
  formatChangePercent,
  formatMetricValue,
  formatTimeWithVariant,
  padToDisplayWidth,
  rowMatchesAnyCondition,
} from './utils.js';

dotenv.config({ path: '.env.local' });

/** 默认查询标的代码 */
const DEFAULT_SYMBOL = 'HSI.HK';

/** 获取 K 线数量（覆盖当日 + 前一日用于指标预热） */
const CANDLE_COUNT = 1000;

/** 指标计算参数 */
const COMPUTE_OPTIONS: ComputeMinuteRowsOptions = {
  rsiPeriod: 6,
  kdjPeriod: 9,
  mfiPeriod: 14,
  adxPeriod: 14,
  ema5Period: 5,
  vpVaPercent: 0.7,
  vpBins: 80,
};

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

const ANSI_RESET = '\u001B[0m';
const ANSI_GREEN = '\u001B[32m';
const ANSI_RED = '\u001B[31m';

/**
 * 格式化数字文本。默认行为：无效值返回 "-"。
 *
 * @param value 待格式化值
 * @param digits 小数位数
 * @returns 格式化后的文本
 */
function formatNumber(value: number | null | undefined, digits: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '-';
  }
  return value.toFixed(digits);
}

/**
 * 输出指标表格（每分钟两行：高/低，每行独立着色）。
 *
 * @param rows 分钟指标结果
 * @param symbol 标的代码
 * @param date 交易日期
 * @returns 无返回值
 */
function displayRows(rows: ReadonlyArray<MinuteIndicatorRow>, symbol: string, date: string): void {
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
  const header = `|${headerCells.join('|')}|`;
  const separator = `|${colWidths.map((width) => '-'.repeat(width)).join('|')}|`;

  console.log(header);
  console.log(separator);

  for (const row of rows) {
    const lineCells = [
      padToDisplayWidth(formatTimeWithVariant(row.time, row.variant), colWidths[0]),
      padToDisplayWidth(formatNumber(row.close, 3), colWidths[1]),
      padToDisplayWidth(formatChangePercent(row.changePercent), colWidths[2]),
      padToDisplayWidth(String(Math.round(row.volume)), colWidths[3]),
      padToDisplayWidth(formatMetricValue(row.ema5), colWidths[4]),
      padToDisplayWidth(formatMetricValue(row.rsi6), colWidths[5]),
      padToDisplayWidth(formatMetricValue(row.kdj?.k), colWidths[6]),
      padToDisplayWidth(formatMetricValue(row.kdj?.d), colWidths[7]),
      padToDisplayWidth(formatMetricValue(row.kdj?.j), colWidths[8]),
      padToDisplayWidth(formatMetricValue(row.mfi), colWidths[9]),
      padToDisplayWidth(formatMetricValue(row.adx), colWidths[10]),
      padToDisplayWidth(row.vp === null ? '-' : formatNumber(row.vp.poc, 3), colWidths[11]),
      padToDisplayWidth(row.vp === null ? '-' : formatNumber(row.vp.vah, 3), colWidths[12]),
      padToDisplayWidth(row.vp === null ? '-' : formatNumber(row.vp.val, 3), colWidths[13]),
      padToDisplayWidth(formatMetricValue(row.vaPositionInValueArea), colWidths[14]),
    ];
    const line = `|${lineCells.join('|')}|`;

    const isGreen = rowMatchesAnyCondition(row, GREEN_CONDITIONS, 'green');
    const isRed = rowMatchesAnyCondition(row, RED_CONDITIONS, 'red');

    let prefix = '';
    if (isGreen) {
      prefix = ANSI_GREEN;
    } else if (isRed) {
      prefix = ANSI_RED;
    }
    const suffix = isGreen || isRed ? ANSI_RESET : '';
    console.log(`${prefix}${line}${suffix}`);

    if (row.variant === 'low') {
      console.log('');
    }
  }
}

async function main(): Promise<void> {
  const symbol = process.argv[2] ?? DEFAULT_SYMBOL;

  console.log(`查询标的: ${symbol}`);
  console.log('正在获取数据...');

  const config = createConfig({ env: process.env });
  const quoteContext = await QuoteContext.new(config);
  const candles = await quoteContext.candlesticks(
    symbol,
    Period.Min_1,
    CANDLE_COUNT,
    AdjustType.NoAdjust,
    TradeSessions.Intraday,
  );

  if (candles.length === 0) {
    console.log('未获取到分钟 K 线数据');
    return;
  }

  console.log(`获取到 ${candles.length} 根 K 线`);

  const { rows, todayDate } = computeMinuteRows(candles, COMPUTE_OPTIONS);
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

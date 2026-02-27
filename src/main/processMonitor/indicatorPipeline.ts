/**
 * 指标处理流水线模块
 *
 * 功能：
 * - 从行情服务获取监控标的的 K 线数据
 * - 根据 K 线数据计算技术指标（RSI、KDJ、MACD、MFI、EMA、PSY）
 * - 构建指标快照并缓存到 indicatorCache
 * - 释放旧的快照对象以支持对象池复用
 *
 * 指标参数：
 * - RSI：默认周期 [6, 12, 24]
 * - EMA：默认周期 [5, 10, 20]
 * - PSY：默认周期 [5, 10, 20]
 * - KDJ：默认周期 9
 * - MACD：快线 12、慢线 26、信号线 9
 * - MFI：默认周期 14
 */
import { buildIndicatorSnapshot, getCandleFingerprint } from '../../services/indicators/utils.js';
import { logger } from '../../utils/logger/index.js';
import { formatSymbolDisplay, releaseSnapshotObjects } from '../../utils/helpers/index.js';
import { TRADING } from '../../constants/index.js';
import type { CandleData } from '../../types/data.js';
import type { IndicatorSnapshot } from '../../types/quote.js';
import type { IndicatorPipelineParams } from './types.js';

/**
 * 类型保护：判断 unknown 是否为可索引对象。
 *
 * @param value 待判断值
 * @returns true 表示可按键读取字段
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * 类型保护：判断 unknown 是否可作为 CandleValue 的对象分支（含 toString 方法）。
 *
 * @param value 待判断值
 * @returns true 表示可作为 CandleValue
 */
function isCandleObjectValue(value: unknown): value is { toString: () => string } {
  return isRecord(value) && typeof value.toString === 'function';
}

/**
 * 将 unknown 标准化为 CandleValue。
 *
 * @param value 原始字段值
 * @returns 规范后的 CandleValue
 */
function normalizeCandleValue(value: unknown): CandleData['close'] {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return value;
  }
  if (isCandleObjectValue(value)) {
    return value;
  }
  return undefined;
}

/**
 * 将 SDK K 线数组标准化为内部 CandleData 数组。
 *
 * @param candles 原始 K 线数据
 * @returns 标准化后的 CandleData 数组
 */
function normalizeCandles(candles: ReadonlyArray<unknown>): ReadonlyArray<CandleData> {
  const normalized: CandleData[] = [];
  for (const candle of candles) {
    if (!isRecord(candle)) {
      continue;
    }
    normalized.push({
      open: normalizeCandleValue(candle['open']),
      high: normalizeCandleValue(candle['high']),
      low: normalizeCandleValue(candle['low']),
      close: normalizeCandleValue(candle['close']),
      volume: normalizeCandleValue(candle['volume']),
    });
  }
  return normalized;
}

/**
 * 执行指标处理流水线。
 * 获取 K 线数据后计算技术指标并缓存快照；若 K 线指纹未变化则直接复用上次快照，
 * 避免重复计算。处理完成后释放旧快照对象以支持对象池复用。
 */
export async function runIndicatorPipeline(
  params: IndicatorPipelineParams,
): Promise<IndicatorSnapshot | null> {
  const { monitorSymbol, monitorContext, mainContext, monitorQuote } = params;
  const { marketDataClient, indicatorCache, marketMonitor } = mainContext;
  const { state, rsiPeriods, emaPeriods, psyPeriods } = monitorContext;

  const monitorCandles = await marketDataClient
    .getRealtimeCandlesticks(monitorSymbol, TRADING.CANDLE_PERIOD, TRADING.CANDLE_COUNT)
    .catch((err: unknown) => {
      logger.error(`获取监控标的 K 线数据失败: ${monitorSymbol}`, err);
      return null;
    });

  if (!monitorCandles || monitorCandles.length === 0) {
    logger.warn(
      `未获取到监控标的 ${formatSymbolDisplay(monitorSymbol, monitorContext.monitorSymbolName)} K线数据`,
    );
    return null;
  }

  const candles = normalizeCandles(monitorCandles);
  const fingerprint = getCandleFingerprint(candles);

  if (
    fingerprint !== null &&
    fingerprint === state.lastCandleFingerprint &&
    state.lastMonitorSnapshot !== null
  ) {
    indicatorCache.push(monitorSymbol, state.lastMonitorSnapshot);
    marketMonitor.monitorIndicatorChanges(
      state.lastMonitorSnapshot,
      monitorQuote,
      monitorSymbol,
      emaPeriods,
      rsiPeriods,
      psyPeriods,
      state,
    );
    return state.lastMonitorSnapshot;
  }

  const monitorSnapshot = buildIndicatorSnapshot(
    monitorSymbol,
    candles,
    rsiPeriods,
    emaPeriods,
    psyPeriods,
  );

  if (!monitorSnapshot) {
    logger.warn(
      `[${formatSymbolDisplay(monitorSymbol, monitorContext.monitorSymbolName)}] 无法构建指标快照，跳过本次处理`,
    );
    return null;
  }

  marketMonitor.monitorIndicatorChanges(
    monitorSnapshot,
    monitorQuote,
    monitorSymbol,
    emaPeriods,
    rsiPeriods,
    psyPeriods,
    state,
  );

  indicatorCache.push(monitorSymbol, monitorSnapshot);

  if (state.lastMonitorSnapshot !== monitorSnapshot) {
    releaseSnapshotObjects(state.lastMonitorSnapshot, state.monitorValues);
  }
  state.lastMonitorSnapshot = monitorSnapshot;
  if (fingerprint !== null) {
    state.lastCandleFingerprint = fingerprint;
  }

  return monitorSnapshot;
}

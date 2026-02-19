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
import { buildIndicatorSnapshot } from '../../services/indicators/index.js';
import { getCandleFingerprint } from '../../services/indicators/utils.js';
import { logger } from '../../utils/logger/index.js';
import { formatSymbolDisplay, releaseSnapshotObjects } from '../../utils/helpers/index.js';
import { TRADING } from '../../constants/index.js';
import type { CandleData } from '../../types/data.js';
import type { IndicatorSnapshot } from '../../types/quote.js';
import type { IndicatorPipelineParams } from './types.js';

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
    .catch(() => null);

  if (!monitorCandles || monitorCandles.length === 0) {
    logger.warn(
      `未获取到监控标的 ${formatSymbolDisplay(monitorSymbol, monitorContext.monitorSymbolName)} K线数据`,
    );
    return null;
  }

  // LongPort SDK 返回 Candlestick[]，与内部 CandleData 结构兼容，此处作为桥接类型使用
  const candles = monitorCandles as CandleData[];
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

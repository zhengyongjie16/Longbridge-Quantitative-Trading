/**
 * @module processMonitor/indicatorPipeline
 * @description 行情→K线→指标快照→缓存
 */
import { buildIndicatorSnapshot } from '../../services/indicators/index.js';
import { logger } from '../../utils/logger/index.js';
import { formatSymbolDisplay, releaseSnapshotObjects } from '../../utils/helpers/index.js';
import { TRADING } from '../../constants/index.js';
import type { CandleData, IndicatorSnapshot } from '../../types/index.js';
import type { IndicatorPipelineParams } from './types.js';

export async function runIndicatorPipeline(
  params: IndicatorPipelineParams,
): Promise<IndicatorSnapshot | null> {
  const { monitorSymbol, monitorContext, mainContext, monitorQuote } = params;
  const { marketDataClient, indicatorCache, marketMonitor } = mainContext;
  const { state, rsiPeriods, emaPeriods, psyPeriods } = monitorContext;

  const monitorCandles = await marketDataClient
    .getCandlesticks(monitorSymbol, TRADING.CANDLE_PERIOD, TRADING.CANDLE_COUNT)
    .catch(() => null);

  if (!monitorCandles || monitorCandles.length === 0) {
    logger.warn(
      `未获取到监控标的 ${formatSymbolDisplay(monitorSymbol, monitorContext.monitorSymbolName)} K线数据`,
    );
    return null;
  }

  const monitorSnapshot = buildIndicatorSnapshot(
    monitorSymbol,
    monitorCandles as CandleData[],
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

  return monitorSnapshot;
}

/**
 * 指标处理流水线模块
 *
 * 功能：
 * - 从应用层本地 K 线缓存读取快照
 * - 推进增量 runtime 并构建最新 snapshot
 * - 更新 monitorState.latest snapshot
 */
import {
  bootstrapIndicatorRuntime,
  buildSnapshotFromRuntime,
  updateRuntimeForCandlestickSnapshot,
} from '../../services/indicators/runtime/index.js';
import { logger } from '../../utils/logger/index.js';
import { releaseSnapshotObjects } from '../../utils/helpers/index.js';
import { TRADING } from '../../constants/index.js';
import type { IndicatorSnapshot } from '../../types/quote.js';
import type { IndicatorPipelineParams } from './types.js';
import { formatSymbolDisplay } from '../../utils/display/index.js';

/**
 * 执行指标处理流水线。
 * 每次调用都基于当前权威 candlestick snapshot 推进增量 runtime。
 */
export function runIndicatorPipeline(params: IndicatorPipelineParams): IndicatorSnapshot | null {
  const { monitorSymbol, monitorContext, mainContext } = params;
  const { marketDataClient } = mainContext;
  const { state, indicatorProfile } = monitorContext;

  const cacheSnapshot = marketDataClient.getCandlestickSnapshot(
    monitorSymbol,
    TRADING.CANDLE_PERIOD,
  );
  if (cacheSnapshot === null || !cacheSnapshot.initialized || cacheSnapshot.candles.length === 0) {
    logger.warn(
      `未获取到监控标的 ${formatSymbolDisplay(monitorSymbol, monitorContext.monitorSymbolName)} K线缓存快照`,
    );
    return null;
  }

  let runtime = state.incrementalIndicatorRuntime;
  runtime =
    runtime === null
      ? bootstrapIndicatorRuntime({
          symbol: monitorSymbol,
          cacheSnapshot,
          indicatorProfile,
        })
      : updateRuntimeForCandlestickSnapshot({
          runtime,
          cacheSnapshot,
        });

  if (runtime === null) {
    logger.warn(
      `[${formatSymbolDisplay(monitorSymbol, monitorContext.monitorSymbolName)}] 无法从缓存快照构建增量运行态，跳过本次处理`,
    );
    return null;
  }

  const monitorSnapshot = buildSnapshotFromRuntime(runtime);
  if (!monitorSnapshot) {
    logger.warn(
      `[${formatSymbolDisplay(monitorSymbol, monitorContext.monitorSymbolName)}] 无法构建指标快照，跳过本次处理`,
    );
    return null;
  }

  if (state.lastMonitorSnapshot !== monitorSnapshot) {
    releaseSnapshotObjects(state.lastMonitorSnapshot, state.monitorValues);
  }

  state.incrementalIndicatorRuntime = runtime;
  state.lastMonitorSnapshot = monitorSnapshot;
  return monitorSnapshot;
}

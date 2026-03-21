/**
 * 指标处理流水线模块
 *
 * 功能：
 * - 每秒从应用层本地 K 线缓存读取快照
 * - 在缓存 version 未变化时复用上次快照
 * - 在缓存 version 变化时推进增量 runtime 并构建新快照
 * - 每拍都写入 indicatorCache，保持延迟验证时间轴连续
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
 * 缓存 version 不变时复用上次快照，但仍按主循环采样时间写入 indicatorCache。
 */
export function runIndicatorPipeline(params: IndicatorPipelineParams): IndicatorSnapshot | null {
  const { monitorSymbol, monitorContext, mainContext, monitorQuote } = params;
  const { marketDataClient, indicatorCache, marketMonitor } = mainContext;
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

  const klineTimestamp = cacheSnapshot.lastBarTimestamp;
  if (
    state.lastCandlestickCacheVersion !== null &&
    cacheSnapshot.version === state.lastCandlestickCacheVersion &&
    state.lastMonitorSnapshot !== null
  ) {
    // indicatorCache 继续按主循环采样时间每秒写入，供 delayed verification 按真实时间轴取样。
    // 即使本秒 K 线缓存没有变化，也要 push 最近一次 snapshot，不能改成“仅事件时写入”。
    indicatorCache.push(monitorSymbol, state.lastMonitorSnapshot);
    marketMonitor.monitorIndicatorChanges({
      monitorSnapshot: state.lastMonitorSnapshot,
      monitorQuote,
      monitorSymbol,
      indicatorProfile,
      klineTimestamp,
      monitorState: state,
    });
    return state.lastMonitorSnapshot;
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

  marketMonitor.monitorIndicatorChanges({
    monitorSnapshot,
    monitorQuote,
    monitorSymbol,
    indicatorProfile,
    klineTimestamp,
    monitorState: state,
  });
  indicatorCache.push(monitorSymbol, monitorSnapshot);
  if (state.lastMonitorSnapshot !== monitorSnapshot) {
    releaseSnapshotObjects(state.lastMonitorSnapshot, state.monitorValues);
  }

  state.incrementalIndicatorRuntime = runtime;
  state.lastMonitorSnapshot = monitorSnapshot;
  state.lastCandlestickCacheVersion = cacheSnapshot.version;
  return monitorSnapshot;
}

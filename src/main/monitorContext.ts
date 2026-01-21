/**
 * 监控标的上下文工厂
 */

import { createHangSengMultiIndicatorStrategy } from '../core/strategy/index.js';
import { createRiskChecker } from '../core/risk/index.js';
import { createUnrealizedLossMonitor } from '../core/unrealizedLossMonitor/index.js';
import { createDelayedSignalVerifier } from '../program/delayedSignalVerifier/index.js';
import { extractEmaPeriods, extractRsiPeriodsWithDefault } from './utils.js';
import type { IndicatorCache } from '../program/indicatorCache/types.js';
import type {
  MonitorConfig,
  MonitorState,
  MonitorContext,
  Quote,
  Trader,
} from '../types/index.js';

/**
 * 创建监控标的上下文
 *
 * @param config 监控配置
 * @param state 监控状态
 * @param trader 交易器
 * @param quotesMap 预先批量获取的行情数据 Map（用于获取标的名称，减少 API 调用）
 * @param indicatorCache 指标缓存（全局共享，供延迟验证器查询）
 */
export function createMonitorContext(
  config: MonitorConfig,
  state: MonitorState,
  trader: Trader,
  quotesMap: ReadonlyMap<string, Quote | null>,
  indicatorCache: IndicatorCache,
): MonitorContext {
  // 从预先获取的行情 Map 中提取标的名称（无需单独 API 调用）
  const longQuote = quotesMap.get(config.longSymbol) ?? null;
  const shortQuote = quotesMap.get(config.shortSymbol) ?? null;
  const monitorQuote = quotesMap.get(config.monitorSymbol) ?? null;

  return {
    config,
    state,
    strategy: createHangSengMultiIndicatorStrategy({
      signalConfig: config.signalConfig,
      verificationConfig: config.verificationConfig,
    }),
    // 使用 trader 内部创建的共享 orderRecorder 实例
    // 订单记录更新已移至 orderMonitor，成交时自动更新
    orderRecorder: trader._orderRecorder,
    riskChecker: createRiskChecker({
      options: {
        maxDailyLoss: config.maxDailyLoss,
        maxPositionNotional: config.maxPositionNotional,
        maxUnrealizedLossPerSymbol: config.maxUnrealizedLossPerSymbol,
      },
    }),
    // 每个监控标的独立的浮亏监控器（使用各自的 maxUnrealizedLossPerSymbol 配置）
    unrealizedLossMonitor: createUnrealizedLossMonitor({
      maxUnrealizedLossPerSymbol: config.maxUnrealizedLossPerSymbol ?? 0,
    }),
    // 每个监控标的独立的延迟信号验证器（使用各自的验证配置）
    delayedSignalVerifier: createDelayedSignalVerifier({
      indicatorCache,
      verificationConfig: config.verificationConfig,
    }),
    // 缓存标的名称（避免每次循环重复获取）
    longSymbolName: longQuote?.name ?? config.longSymbol,
    shortSymbolName: shortQuote?.name ?? config.shortSymbol,
    monitorSymbolName: monitorQuote?.name ?? config.monitorSymbol,
    // 缓存规范化后的标的代码（config中已经规范化，直接使用）
    normalizedLongSymbol: config.longSymbol,
    normalizedShortSymbol: config.shortSymbol,
    normalizedMonitorSymbol: config.monitorSymbol,
    // 缓存指标周期配置（避免每次循环重复提取）
    rsiPeriods: extractRsiPeriodsWithDefault(config.signalConfig),
    emaPeriods: extractEmaPeriods(config.verificationConfig),
    // 缓存的行情数据（主循环每秒更新，供 TradeProcessor 使用）
    longQuote,
    shortQuote,
    monitorQuote,
    // 注意：持仓数据通过 lastState.positionCache 获取，不在 MonitorContext 中缓存
  };
}

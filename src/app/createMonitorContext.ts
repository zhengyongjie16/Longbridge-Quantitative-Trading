/**
 * app 监控上下文装配模块
 *
 * 职责：
 * - 创建每个监控标的的独立 MonitorContext
 * - 在装配边界内聚合策略、风控、订单记录与延迟验证器等依赖
 */
import { compileIndicatorUsageProfile } from '../services/indicators/profile/index.js';
import type { MonitorContext } from '../types/state.js';
import { resolveMonitorContextRuntimeSnapshot } from '../utils/utils.js';
import type { MonitorContextFactoryDeps } from './types.js';

/**
 * 创建监控标的运行时上下文，从注册表读取席位状态与版本号，从行情 Map 提取标的名称，
 * 并预编译指标画像，避免主循环每 tick 重复解析。
 *
 * @param deps 工厂依赖（config、state、symbolRegistry、quotesMap、strategy、orderRecorder 等）
 * @returns 该监控标的的 MonitorContext 实例
 */
export function createMonitorContext(deps: MonitorContextFactoryDeps): MonitorContext {
  const {
    config,
    state,
    symbolRegistry,
    quotesMap,
    strategy,
    orderRecorder,
    dailyLossTracker,
    riskChecker,
    unrealizedLossMonitor,
    delayedSignalVerifier,
    autoSymbolManager,
  } = deps;
  const runtimeSnapshot = resolveMonitorContextRuntimeSnapshot(
    config.monitorSymbol,
    symbolRegistry,
    quotesMap,
  );
  const indicatorProfile = compileIndicatorUsageProfile({
    signalConfig: config.signalConfig,
    verificationConfig: config.verificationConfig,
  });

  return {
    config,
    state,
    symbolRegistry,
    seatState: runtimeSnapshot.seatState,
    seatVersion: runtimeSnapshot.seatVersion,
    autoSymbolManager,
    strategy,
    orderRecorder,
    dailyLossTracker,
    riskChecker,
    unrealizedLossMonitor,
    delayedSignalVerifier,
    longSymbolName: runtimeSnapshot.longSymbolName,
    shortSymbolName: runtimeSnapshot.shortSymbolName,
    monitorSymbolName: runtimeSnapshot.monitorSymbolName,
    normalizedMonitorSymbol: config.monitorSymbol,
    indicatorProfile,
    longQuote: runtimeSnapshot.longQuote,
    shortQuote: runtimeSnapshot.shortQuote,
    monitorQuote: runtimeSnapshot.monitorQuote,
  };
}

/**
 * 监控标的上下文工厂模块
 *
 * 功能：
 * - 创建每个监控标的的独立上下文（MonitorContext）
 * - 初始化策略、风险检查器、浮亏监控器、延迟验证器等组件
 * - 缓存标的名称和指标画像配置，避免重复计算
 *
 * 上下文内容：
 * - config/state：监控配置和状态
 * - strategy：信号生成策略
 * - orderRecorder：订单记录器（共享实例）
 * - riskChecker：风险检查器
 * - unrealizedLossMonitor：浮亏监控器
 * - delayedSignalVerifier：延迟信号验证器
 * - 缓存的标的名称和指标画像
 */
import { isSeatReady } from '../autoSymbolManager/utils.js';
import type { MonitorContext } from '../../types/state.js';
import type { MonitorContextFactoryDeps } from './types.js';
import { compileIndicatorUsageProfile } from './utils.js';
import { createMonitorRuntimeStore } from '../../app/runtime/monitorRuntimeStore.js';
import { createLegacyMonitorContextFacade } from '../../app/runtime/legacyStateFacade.js';

/**
 * 创建监控标的运行时上下文，从注册表读取席位状态与版本号，从行情 Map 提取标的名称，
 * 并预编译指标画像，避免主循环每 tick 重复解析。
 * @param deps - 工厂依赖（config、state、symbolRegistry、quotesMap、strategy、orderRecorder 等）
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
    monitorRuntimeStore,
  } = deps;

  const longSeatState = symbolRegistry.getSeatState(config.monitorSymbol, 'LONG');
  const shortSeatState = symbolRegistry.getSeatState(config.monitorSymbol, 'SHORT');
  const longSeatVersion = symbolRegistry.getSeatVersion(config.monitorSymbol, 'LONG');
  const shortSeatVersion = symbolRegistry.getSeatVersion(config.monitorSymbol, 'SHORT');
  const longSymbol = isSeatReady(longSeatState) ? longSeatState.symbol : null;
  const shortSymbol = isSeatReady(shortSeatState) ? shortSeatState.symbol : null;

  // 从预先获取的行情 Map 中提取标的名称（无需单独 API 调用）
  const longQuote = longSymbol ? (quotesMap.get(longSymbol) ?? null) : null;
  const shortQuote = shortSymbol ? (quotesMap.get(shortSymbol) ?? null) : null;
  const monitorQuote = quotesMap.get(config.monitorSymbol) ?? null;
  const indicatorProfile = compileIndicatorUsageProfile({
    signalConfig: config.signalConfig,
    verificationConfig: config.verificationConfig,
  });
  const runtimeStore =
    monitorRuntimeStore ??
    createMonitorRuntimeStore(
      new Map([
        [config.monitorSymbol, state],
      ]),
    );
  const runtimeEntry = runtimeStore.ensureEntry({
    monitorSymbol: config.monitorSymbol,
    state,
    seatState: {
      long: longSeatState,
      short: shortSeatState,
    },
    seatVersion: {
      long: longSeatVersion,
      short: shortSeatVersion,
    },
    longSymbolName: longSymbol ? (longQuote?.name ?? longSymbol) : '',
    shortSymbolName: shortSymbol ? (shortQuote?.name ?? shortSymbol) : '',
    monitorSymbolName: monitorQuote?.name ?? config.monitorSymbol,
    normalizedMonitorSymbol: config.monitorSymbol,
    indicatorProfile,
    longQuote,
    shortQuote,
    monitorQuote,
  });

  return createLegacyMonitorContextFacade({
    config,
    symbolRegistry,
    autoSymbolManager,
    strategy,
    orderRecorder,
    dailyLossTracker,
    riskChecker,
    unrealizedLossMonitor,
    delayedSignalVerifier,
    runtimeEntry,
  });
}

/**
 * 监控标的上下文工厂模块
 *
 * 功能：
 * - 创建每个监控标的的独立上下文（MonitorContext）
 * - 初始化策略、风险检查器、浮亏监控器、延迟验证器等组件
 * - 缓存标的名称和指标周期配置，避免重复计算
 *
 * 上下文内容：
 * - config/state：监控配置和状态
 * - strategy：信号生成策略
 * - orderRecorder：订单记录器（共享实例）
 * - riskChecker：风险检查器
 * - unrealizedLossMonitor：浮亏监控器
 * - delayedSignalVerifier：延迟信号验证器
 * - 缓存的标的名称和指标周期
 */

import { isSeatReady } from '../autoSymbolManager/utils.js';
import type {
  MonitorContext,
} from '../../types/index.js';
import type { MonitorContextFactoryDeps } from './types.js';
import { extractRsiPeriodsWithDefault, extractEmaPeriods, extractPsyPeriods } from './utils.js';

/**
 * 创建监控标的上下文
 *
 * @param deps 依赖注入
 */
export function createMonitorContext(deps: MonitorContextFactoryDeps): MonitorContext {
  const {
    config,
    state,
    symbolRegistry,
    quotesMap,
    strategy,
    orderRecorder,
    riskChecker,
    unrealizedLossMonitor,
    delayedSignalVerifier,
    autoSymbolManager,
  } = deps;

  const longSeatState = symbolRegistry.getSeatState(config.monitorSymbol, 'LONG');
  const shortSeatState = symbolRegistry.getSeatState(config.monitorSymbol, 'SHORT');
  const longSymbol = isSeatReady(longSeatState) ? longSeatState.symbol : null;
  const shortSymbol = isSeatReady(shortSeatState) ? shortSeatState.symbol : null;

  // 从预先获取的行情 Map 中提取标的名称（无需单独 API 调用）
  const longQuote = longSymbol ? (quotesMap.get(longSymbol) ?? null) : null;
  const shortQuote = shortSymbol ? (quotesMap.get(shortSymbol) ?? null) : null;
  const monitorQuote = quotesMap.get(config.monitorSymbol) ?? null;

  return {
    config,
    state,
    symbolRegistry,
    seatState: {
      long: symbolRegistry.getSeatState(config.monitorSymbol, 'LONG'),
      short: symbolRegistry.getSeatState(config.monitorSymbol, 'SHORT'),
    },
    seatVersion: {
      long: symbolRegistry.getSeatVersion(config.monitorSymbol, 'LONG'),
      short: symbolRegistry.getSeatVersion(config.monitorSymbol, 'SHORT'),
    },
    autoSymbolManager,
    strategy,
    // 使用共享 orderRecorder 实例（订单成交后由 orderMonitor 更新）
    orderRecorder,
    riskChecker,
    // 每个监控标的独立的浮亏监控器（使用各自的 maxUnrealizedLossPerSymbol 配置）
    unrealizedLossMonitor,
    // 每个监控标的独立的延迟信号验证器（使用各自的验证配置）
    delayedSignalVerifier,
    // 缓存标的名称（避免每次循环重复获取）
    longSymbolName: longSymbol ? (longQuote?.name ?? longSymbol) : '',
    shortSymbolName: shortSymbol ? (shortQuote?.name ?? shortSymbol) : '',
    monitorSymbolName: monitorQuote?.name ?? config.monitorSymbol,
    normalizedMonitorSymbol: config.monitorSymbol,
    // 缓存指标周期配置（避免每次循环重复提取）
    rsiPeriods: extractRsiPeriodsWithDefault(config.signalConfig),
    emaPeriods: extractEmaPeriods(config.verificationConfig),
    psyPeriods: extractPsyPeriods(config.signalConfig, config.verificationConfig),
    // 缓存的行情数据（主循环每秒更新，供买入/卖出处理器使用）
    longQuote,
    shortQuote,
    monitorQuote,
    // 注意：持仓数据通过 lastState.positionCache 获取，不在 MonitorContext 中缓存
  };
}

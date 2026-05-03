/**
 * app 监控上下文装配模块
 *
 * 职责：
 * - 创建单个 monitor 的 MonitorContext
 * - 批量装配全部 monitor 配置并写回 post-gate runtime 的 monitorContexts Map
 * - 固化 monitorStates 与 tradingConfig 的一一对应装配不变量
 */
import { createDefaultTradingSignalStrategyFactory } from '../../core/strategy/index.js';
import { createPositionLimitChecker } from '../../core/riskController/positionLimitChecker.js';
import { createRiskChecker } from '../../core/riskController/index.js';
import { createUnrealizedLossChecker } from '../../core/riskController/unrealizedLossChecker.js';
import { createUnrealizedLossMonitor } from '../../core/riskController/unrealizedLossMonitor.js';
import { createWarrantRiskChecker } from '../../core/riskController/warrantRiskChecker.js';
import { createDelayedSignalVerifier } from '../../main/asyncProgram/delayedSignalVerifier/index.js';
import { createAutoSymbolManager } from '../../services/autoSymbolManager/index.js';
import { compileIndicatorUsageProfile } from '../../services/indicators/profile/index.js';
import type { MonitorContext } from '../../types/state.js';
import { resolveMonitorContextRuntimeSnapshot } from '../../utils/utils.js';
import type { CreateMonitorContextsParams, MonitorContextFactoryDeps } from '../types.js';

const DEFAULT_STRATEGY_FACTORY = createDefaultTradingSignalStrategyFactory();

/**
 * 创建监控标的运行时上下文，从注册表读取席位状态与版本号，从行情 Map 提取标的名称，
 * 并预编译指标画像，避免运行期重复解析。
 *
 * @param deps 工厂依赖（config、state、symbolRegistry、quotesMap、strategy、orderRecorder 等）
 * @returns 该监控标的的 MonitorContext 实例
 */
function createMonitorContext(deps: MonitorContextFactoryDeps): MonitorContext {
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
  };
}

/**
 * 批量创建全部监控上下文。
 * 默认行为：若某个 monitor 缺少对应 monitorState，则视为装配不变量被破坏并直接抛错。
 *
 * @param params 监控上下文装配所需的 pre/post gate 运行时对象与 quotesMap
 * @returns 无返回值；直接填充 postGateRuntime.monitorContexts
 */
export function createMonitorContexts(params: CreateMonitorContextsParams): void {
  const {
    preGateRuntime,
    postGateRuntime,
    quotesMap,
    strategyFactory = DEFAULT_STRATEGY_FACTORY,
  } = params;

  for (const monitorConfig of preGateRuntime.tradingConfig.monitors) {
    const monitorState = postGateRuntime.lastState.monitorStates.get(monitorConfig.monitorSymbol);
    if (!monitorState) {
      throw new Error(`监控标的缺少初始化状态: ${monitorConfig.monitorSymbol}`);
    }

    const riskChecker = createRiskChecker({
      warrantRiskChecker: createWarrantRiskChecker(),
      positionLimitChecker: createPositionLimitChecker({
        maxPositionNotional: monitorConfig.maxPositionNotional,
      }),
      unrealizedLossChecker: createUnrealizedLossChecker({
        maxUnrealizedLossPerSymbol: monitorConfig.maxUnrealizedLossPerSymbol,
      }),
    });
    const autoSymbolManager = createAutoSymbolManager({
      monitorConfig,
      symbolRegistry: preGateRuntime.symbolRegistry,
      marketDataClient: preGateRuntime.marketDataClient,
      trader: postGateRuntime.trader,
      orderRecorder: postGateRuntime.trader.orderRecorder,
      riskChecker,
      warrantListCacheConfig: preGateRuntime.warrantListCacheConfig,
      getTradingCalendarSnapshot: () =>
        postGateRuntime.lastState.tradingCalendarSnapshot ?? new Map(),
    });
    const strategy = strategyFactory({
      signalConfig: monitorConfig.signalConfig,
      verificationConfig: monitorConfig.verificationConfig,
    });
    const context = createMonitorContext({
      config: monitorConfig,
      state: monitorState,
      symbolRegistry: preGateRuntime.symbolRegistry,
      quotesMap,
      strategy,
      orderRecorder: postGateRuntime.trader.orderRecorder,
      dailyLossTracker: postGateRuntime.dailyLossTracker,
      riskChecker,
      unrealizedLossMonitor: createUnrealizedLossMonitor({
        maxUnrealizedLossPerSymbol: monitorConfig.maxUnrealizedLossPerSymbol,
      }),
      delayedSignalVerifier: createDelayedSignalVerifier({
        indicatorCache: postGateRuntime.indicatorCache,
      }),
      autoSymbolManager,
    });

    postGateRuntime.monitorContexts.set(monitorConfig.monitorSymbol, context);
  }
}

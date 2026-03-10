/**
 * app 监控上下文批量装配模块
 *
 * 职责：
 * - 为全部 monitor 配置创建风险检查器、策略、自动寻标管理器与 MonitorContext
 * - 固化 monitorStates 与 tradingConfig 的一一对应装配不变量
 * - 统一写回 post-gate runtime 持有的 monitorContexts Map
 */
import { createHangSengMultiIndicatorStrategy } from '../core/strategy/index.js';
import { createPositionLimitChecker } from '../core/riskController/positionLimitChecker.js';
import { createRiskChecker } from '../core/riskController/index.js';
import { createUnrealizedLossChecker } from '../core/riskController/unrealizedLossChecker.js';
import { createUnrealizedLossMonitor } from '../core/riskController/unrealizedLossMonitor.js';
import { createWarrantRiskChecker } from '../core/riskController/warrantRiskChecker.js';
import { createDelayedSignalVerifier } from '../main/asyncProgram/delayedSignalVerifier/index.js';
import { createAutoSymbolManager } from '../services/autoSymbolManager/index.js';
import { createMonitorContext } from './createMonitorContext.js';
import type { CreateMonitorContextsParams } from './types.js';

/**
 * 批量创建全部监控上下文。
 * 默认行为：若某个 monitor 缺少对应 monitorState，则视为装配不变量被破坏并直接抛错。
 *
 * @param params 监控上下文装配所需的 pre/post gate 运行时对象与 quotesMap
 * @returns 无返回值；直接填充 postGateRuntime.monitorContexts
 */
export function createMonitorContexts(params: CreateMonitorContextsParams): void {
  const { preGateRuntime, postGateRuntime, quotesMap } = params;

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
      options: {
        maxPositionNotional: monitorConfig.maxPositionNotional,
        maxUnrealizedLossPerSymbol: monitorConfig.maxUnrealizedLossPerSymbol,
      },
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
    const strategy = createHangSengMultiIndicatorStrategy({
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

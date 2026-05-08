/**
 * app 异步运行时工厂模块
 *
 * 职责：
 * - 创建监控任务处理器、买入处理器与卖出处理器
 * - 消费已完成顶层装配的共享依赖，不再承担其他 runtime 的绑定副作用
 */
import { createBuyProcessor } from '../../main/asyncProgram/buyProcessor/index.js';
import { createMonitorTaskProcessor } from '../../main/asyncProgram/monitorTaskProcessor/index.js';
import { createSellProcessor } from '../../main/asyncProgram/sellProcessor/index.js';
import { ordinarySignalGuard } from '../../main/ordinarySignalGuard/index.js';
import type { AsyncRuntime, AsyncRuntimeFactoryDeps } from '../types.js';

/**
 * 创建异步运行时对象。
 *
 * @param params pre-gate runtime 与 post-gate runtime
 * @returns 顶层异步处理器集合
 */

export function createAsyncRuntime(params: AsyncRuntimeFactoryDeps): AsyncRuntime {
  const { preGateRuntime, postGateRuntime } = params;
  const { tradingConfig, marketDataClient } = preGateRuntime;
  const {
    monitorContexts,
    trader,
    lastState,
    postTradeConsistencyRuntime,
    signalProcessor,
    doomsdayProtection,
    buyTaskQueue,
    sellTaskQueue,
    monitorTaskQueue,
    switchWakeupRuntime,
    periodicSwitchWakeupRuntime,
    quoteSubscriptionRuntime,
  } = postGateRuntime;
  let fatalError: Error | null = null;
  const fatalRejectors = new Set<(error: Error) => void>();
  const toError = (error: unknown): Error =>
    error instanceof Error ? error : new Error(String(error));
  const handleFatalError = (error: unknown): void => {
    if (fatalError !== null) {
      return;
    }

    fatalError = toError(error);
    for (const reject of fatalRejectors) {
      reject(fatalError);
    }

    fatalRejectors.clear();
  };

  const drainFatalError = (): Promise<never> => {
    if (fatalError !== null) {
      return Promise.reject(fatalError);
    }

    return new Promise<never>((_, reject) => {
      fatalRejectors.add(reject);
    });
  };
  const canProcessOrdinaryTradeTask = (): boolean =>
    ordinarySignalGuard({
      lastState,
      now: new Date(Date.now()),
      doomsdayProtectionEnabled: tradingConfig.global.doomsdayProtection,
    });

  const monitorTaskProcessor = createMonitorTaskProcessor({
    monitorTaskQueue,
    getMonitorContext: (monitorSymbol) => monitorContexts.get(monitorSymbol) ?? null,
    trader,
    marketDataClient,
    switchWakeupRuntime,
    periodicSwitchWakeupRuntime,
    quoteSubscriptionRuntime,
    lastState,
    tradingConfig,
    getCanProcessTask: () => lastState.isTradingEnabled,
    getCanTradeNow: canProcessOrdinaryTradeTask,
    onFatalError: handleFatalError,
  });
  const buyProcessor = createBuyProcessor({
    taskQueue: buyTaskQueue,
    getMonitorContext: (monitorSymbol) => monitorContexts.get(monitorSymbol),
    signalProcessor,
    trader,
    marketDataClient,
    doomsdayProtection,
    getLastState: () => lastState,
    getIsHalfDay: () => lastState.isHalfDay ?? false,
    getCanProcessTask: canProcessOrdinaryTradeTask,
    onFatalError: handleFatalError,
  });
  const sellProcessor = createSellProcessor({
    taskQueue: sellTaskQueue,
    getMonitorContext: (monitorSymbol) => monitorContexts.get(monitorSymbol),
    signalProcessor,
    trader,
    marketDataClient,
    getLastState: () => lastState,
    postTradeConsistencyRuntime,
    getCanProcessTask: canProcessOrdinaryTradeTask,
    onFatalError: handleFatalError,
  });

  return {
    monitorTaskProcessor,
    buyProcessor,
    sellProcessor,
    drainFatalError,
  };
}

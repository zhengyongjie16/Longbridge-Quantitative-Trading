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
import { clearMonitorDirectionQueuesWithLog } from './queueCleanup.js';
import { logger } from '../../utils/logger/index.js';
import type { AsyncRuntime, AsyncRuntimeFactoryDeps } from '../types.js';

/**
 * 创建异步运行时对象。
 *
 * @param params pre-gate runtime 与 post-gate runtime
 * @returns 顶层异步处理器集合
 */
export function createAsyncRuntime(params: AsyncRuntimeFactoryDeps): AsyncRuntime {
  const { preGateRuntime, postGateRuntime } = params;
  const { tradingConfig } = preGateRuntime;
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
    quoteSubscriptionRuntime,
  } = postGateRuntime;
  const monitorTaskProcessor = createMonitorTaskProcessor({
    monitorTaskQueue,
    getMonitorContext: (monitorSymbol) => monitorContexts.get(monitorSymbol) ?? null,
    clearMonitorDirectionQueues: (monitorSymbol, direction) => {
      clearMonitorDirectionQueuesWithLog({
        monitorSymbol,
        direction,
        monitorContexts,
        buyTaskQueue,
        sellTaskQueue,
        monitorTaskQueue,
        logger,
      });
    },
    trader,
    marketDataClient: preGateRuntime.marketDataClient,
    switchWakeupRuntime,
    quoteSubscriptionRuntime,
    lastState,
    tradingConfig,
    getCanProcessTask: () => lastState.isTradingEnabled,
  });
  const buyProcessor = createBuyProcessor({
    taskQueue: buyTaskQueue,
    getMonitorContext: (monitorSymbol) => monitorContexts.get(monitorSymbol),
    signalProcessor,
    trader,
    marketDataClient: preGateRuntime.marketDataClient,
    doomsdayProtection,
    getLastState: () => lastState,
    getIsHalfDay: () => lastState.isHalfDay ?? false,
    getCanProcessTask: () => lastState.isTradingEnabled,
  });
  const sellProcessor = createSellProcessor({
    taskQueue: sellTaskQueue,
    getMonitorContext: (monitorSymbol) => monitorContexts.get(monitorSymbol),
    signalProcessor,
    trader,
    marketDataClient: preGateRuntime.marketDataClient,
    getLastState: () => lastState,
    postTradeConsistencyRuntime,
    getCanProcessTask: () => lastState.isTradingEnabled,
  });

  return {
    monitorTaskProcessor,
    buyProcessor,
    sellProcessor,
  };
}

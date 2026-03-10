/**
 * app 生命周期运行时装配模块
 *
 * 职责：
 * - 在唯一注册点固定 cache domain 注册顺序
 * - 创建 dayLifecycleManager
 * - 固化 open rebuild 统一入口与 signal runtime 恢复顺序
 */
import { createDayLifecycleManager } from '../main/lifecycle/dayLifecycleManager.js';
import { createGlobalStateDomain } from '../main/lifecycle/cacheDomains/globalStateDomain.js';
import { createMarketDataDomain } from '../main/lifecycle/cacheDomains/marketDataDomain.js';
import { createOrderDomain } from '../main/lifecycle/cacheDomains/orderDomain.js';
import { createRiskDomain } from '../main/lifecycle/cacheDomains/riskDomain.js';
import { createSeatDomain } from '../main/lifecycle/cacheDomains/seatDomain.js';
import { createSignalRuntimeDomain } from '../main/lifecycle/cacheDomains/signalRuntimeDomain.js';
import { executeTradingDayOpenRebuild } from './rebuild.js';
import { logger } from '../utils/logger/index.js';
import { signalObjectPool } from '../utils/objectPool/index.js';
import type { CacheDomain, DayLifecycleManager } from '../main/lifecycle/types.js';
import type { LifecycleRuntimeFactories, LifecycleRuntimeFactoryDeps } from './types.js';

const DEFAULT_LIFECYCLE_RUNTIME_FACTORIES: LifecycleRuntimeFactories = {
  createSignalRuntimeDomain,
  createMarketDataDomain,
  createSeatDomain,
  createOrderDomain,
  createRiskDomain,
  createGlobalStateDomain,
  executeTradingDayOpenRebuild,
  createDayLifecycleManager,
};

/**
 * 按固定顺序创建 lifecycle cache domains。
 *
 * @param params pre-gate runtime、post-gate runtime、异步 runtime 与重建函数
 * @returns 按注册顺序排列的 cache domains
 */
export function createLifecycleCacheDomains(
  params: LifecycleRuntimeFactoryDeps,
  factories: LifecycleRuntimeFactories = DEFAULT_LIFECYCLE_RUNTIME_FACTORIES,
): ReadonlyArray<CacheDomain> {
  const { preGateRuntime, postGateRuntime, asyncRuntime, rebuildTradingDayState } = params;
  const { tradingConfig, symbolRegistry, warrantListCache, marketDataClient } = preGateRuntime;
  const {
    monitorContexts,
    indicatorCache,
    buyTaskQueue,
    sellTaskQueue,
    monitorTaskQueue,
    refreshGate,
    trader,
    lastState,
    signalProcessor,
    dailyLossTracker,
    liquidationCooldownTracker,
    loadTradingDayRuntimeSnapshot,
  } = postGateRuntime;
  const {
    buyProcessor,
    sellProcessor,
    monitorTaskProcessor,
    orderMonitorWorker,
    postTradeRefresher,
  } = asyncRuntime;
  const {
    createSignalRuntimeDomain: buildSignalRuntimeDomain,
    createMarketDataDomain: buildMarketDataDomain,
    createSeatDomain: buildSeatDomain,
    createOrderDomain: buildOrderDomain,
    createRiskDomain: buildRiskDomain,
    createGlobalStateDomain: buildGlobalStateDomain,
    executeTradingDayOpenRebuild: runTradingDayOpenRebuild,
  } = factories;

  return [
    buildSignalRuntimeDomain({
      monitorContexts,
      buyProcessor,
      sellProcessor,
      monitorTaskProcessor,
      orderMonitorWorker,
      postTradeRefresher,
      indicatorCache,
      buyTaskQueue,
      sellTaskQueue,
      monitorTaskQueue,
      refreshGate,
      releaseSignal: (signal) => {
        signalObjectPool.release(signal);
      },
    }),
    buildMarketDataDomain({
      marketDataClient,
    }),
    buildSeatDomain({
      tradingConfig,
      symbolRegistry,
      monitorContexts,
      warrantListCache,
    }),
    buildOrderDomain({
      trader,
    }),
    buildRiskDomain({
      signalProcessor,
      dailyLossTracker,
      monitorContexts,
      liquidationCooldownTracker,
    }),
    buildGlobalStateDomain({
      lastState,
      runTradingDayOpenRebuild: async (now) => {
        await runTradingDayOpenRebuild({
          now,
          loadTradingDayRuntimeSnapshot,
          rebuildTradingDayState,
        });
      },
    }),
  ];
}

/**
 * 创建 dayLifecycleManager。
 *
 * @param params pre-gate runtime、post-gate runtime、异步 runtime 与重建函数
 * @param factories cache domain 与 dayLifecycleManager 工厂集合；默认使用生产实现
 * @returns 生命周期管理器
 */
export function createLifecycleRuntime(
  params: LifecycleRuntimeFactoryDeps,
  factories: LifecycleRuntimeFactories = DEFAULT_LIFECYCLE_RUNTIME_FACTORIES,
): DayLifecycleManager {
  const { postGateRuntime } = params;
  const cacheDomains = createLifecycleCacheDomains(params, factories);

  return factories.createDayLifecycleManager({
    mutableState: postGateRuntime.lastState,
    cacheDomains,
    logger,
  });
}

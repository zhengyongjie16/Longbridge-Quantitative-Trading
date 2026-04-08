/**
 * app post-gate runtime 工厂模块
 *
 * 职责：
 * - 创建 startup gate 之后才能初始化的共享运行时对象
 * - 固定 lastState、trader、快照加载器与异步基础设施的唯一创建点
 * - 保持 post-gate 对象所有权清单集中
 */
import fs from 'node:fs';
import { createTrader } from '../../core/trader/index.js';
import { createOrderFilteringEngine } from '../../core/orderRecorder/orderFilteringEngine.js';
import { classifyAndConvertOrders } from '../../core/orderRecorder/utils.js';
import { resolveOrderOwnership } from '../../core/orderRecorder/orderOwnershipParser.js';
import { createDailyLossTracker } from '../../core/riskController/dailyLossTracker.js';
import { createDoomsdayProtection } from '../../core/doomsdayProtection/index.js';
import { createSignalProcessor } from '../../core/signalProcessor/index.js';
import { createPostTradeConsistencyRuntime } from './createPostTradeConsistencyRuntime.js';
import { createProtectiveLiquidationEpisodeTracker } from '../../core/trader/protectiveLiquidationEpisodeTracker/index.js';
import { createIndicatorCache } from '../../main/asyncProgram/indicatorCache/index.js';
import { createMonitorTaskQueue } from '../../main/asyncProgram/monitorTaskQueue/index.js';
import {
  createBuyTaskQueue,
  createSellTaskQueue,
} from '../../main/asyncProgram/tradeTaskQueue/index.js';
import { createLoadTradingDayRuntimeSnapshot } from '../../main/lifecycle/loadTradingDayRuntimeSnapshot.js';
import { createTradingRiskEventRuntime } from '../../main/tradingRiskEventRuntime/tradingRiskEventRuntime.js';
import { createDefaultMonitorQuoteEventRuntime } from '../../main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.js';
import { createSwitchWakeupRuntime } from '../../main/monitorQuoteEventRuntime/switchWakeupRuntime.js';
import { createMarketMonitor } from '../../services/marketMonitor/index.js';
import { createLiquidationCooldownTracker } from '../../services/liquidationCooldown/index.js';
import { createTradeLogHydrator } from '../../services/liquidationCooldown/tradeLogHydrator.js';
import { createPositionCache } from '../../utils/positionCache/index.js';
import { initMonitorState } from '../../utils/helpers/index.js';
import { resolveLogRootDir } from '../../utils/runtime/index.js';
import { getHKDateKey, toHongKongTimeIso } from '../../utils/time/index.js';
import { logger } from '../../utils/logger/index.js';
import type { LastState, MonitorContext } from '../../types/state.js';
import type { MonitorTaskDataMap } from '../../main/asyncProgram/monitorTaskProcessor/types.js';
import type {
  CreatePostGateRuntimeParams,
  MutableMonitorContextsPostGateRuntime,
} from '../types.js';

/**
 * 创建 post-gate 阶段共享运行时对象。
 *
 * @param params 当前环境、pre-gate runtime 与当前时间
 * @returns post-gate runtime
 */
export async function createPostGateRuntime(
  params: CreatePostGateRuntimeParams,
): Promise<MutableMonitorContextsPostGateRuntime> {
  const { env, preGateRuntime, now } = params;
  const {
    config,
    tradingConfig,
    symbolRegistry,
    marketDataClient,
    startupTradingDayInfo,
    warrantListCacheConfig,
  } = preGateRuntime;
  const liquidationCooldownTracker = createLiquidationCooldownTracker({ nowMs: () => Date.now() });
  const dailyLossTracker = createDailyLossTracker({
    filteringEngine: createOrderFilteringEngine(),
    resolveOrderOwnership,
    classifyAndConvertOrders,
    toHongKongTimeIso,
  });
  const protectiveLiquidationEpisodeTracker = createProtectiveLiquidationEpisodeTracker();
  const monitorContexts = new Map<string, MonitorContext>();
  const initialDayKey = getHKDateKey(now);
  const lastState: LastState = {
    canTrade: null,
    isHalfDay: null,
    openProtectionActive: null,
    currentDayKey: initialDayKey,
    lifecycleState: 'ACTIVE',
    pendingOpenRebuild: false,
    targetTradingDayKey: null,
    isTradingEnabled: true,
    cachedAccount: null,
    cachedPositions: [],
    positionCache: createPositionCache(),
    cachedTradingDayInfo: startupTradingDayInfo,
    tradingCalendarSnapshot: new Map([[initialDayKey, startupTradingDayInfo]]),
    monitorStates: new Map(
      tradingConfig.monitors.map((monitorConfig) => [
        monitorConfig.monitorSymbol,
        initMonitorState(monitorConfig),
      ]),
    ),
    allTradingSymbols: new Set(),
  };
  let traderRef: Awaited<ReturnType<typeof createTrader>> | null = null;
  const postTradeConsistencyRuntime = createPostTradeConsistencyRuntime({
    getTrader: () => {
      if (traderRef === null) {
        throw new Error('[postTradeConsistencyRuntime] Trader 尚未初始化');
      }

      return traderRef;
    },
    lastState,
  });
  const trader = await createTrader({
    config,
    tradingConfig,
    marketDataClient,
    symbolRegistry,
    dailyLossTracker,
    protectiveLiquidationEpisodeTracker,
    postTradeConsistencyRuntime,
    isExecutionAllowed: () => lastState.isTradingEnabled,
  });
  traderRef = trader;
  const tradeLogHydrator = createTradeLogHydrator({
    readFileSync: fs.readFileSync,
    existsSync: fs.existsSync,
    resolveLogRootDir: () => resolveLogRootDir(env),
    nowMs: () => Date.now(),
    logger,
    tradingConfig,
    liquidationCooldownTracker,
  });
  const loadTradingDayRuntimeSnapshot = createLoadTradingDayRuntimeSnapshot({
    marketDataClient,
    trader,
    lastState,
    tradingConfig,
    symbolRegistry,
    dailyLossTracker,
    protectiveLiquidationEpisodeTracker,
    tradeLogHydrator,
    warrantListCacheConfig,
  });
  const marketMonitor = createMarketMonitor();
  const doomsdayProtection = createDoomsdayProtection();
  const tradingRiskEventRuntime = createTradingRiskEventRuntime({
    marketDataClient,
    trader,
    symbolRegistry,
    monitorContexts,
    lastState,
    postTradeConsistencyRuntime,
    doomsdayProtectionEnabled: tradingConfig.global.doomsdayProtection,
    now: () => new Date(),
  });
  const switchWakeupRuntime = createSwitchWakeupRuntime({
    marketDataClient,
    trader,
    symbolRegistry,
    monitorContexts,
    lastState,
    postTradeConsistencyRuntime,
    doomsdayProtectionEnabled: tradingConfig.global.doomsdayProtection,
    now: () => new Date(),
    scheduleTimer: (callback, delayMs) => {
      return setTimeout(callback, delayMs);
    },
    clearTimer: (handle) => {
      clearTimeout(handle);
    },
  });
  const monitorQuoteEventRuntime = createDefaultMonitorQuoteEventRuntime({
    marketDataClient,
    monitorContexts,
    trader,
    lastState,
    postTradeConsistencyRuntime,
    doomsdayProtectionEnabled: tradingConfig.global.doomsdayProtection,
    now: () => new Date(),
    handoffPendingSwitch: switchWakeupRuntime.handoffPendingSwitch,
  });
  const signalProcessor = createSignalProcessor({
    tradingConfig,
    liquidationCooldownTracker,
  });
  const maxDelaySeconds = Math.max(
    ...tradingConfig.monitors.map((monitorConfig) =>
      Math.max(
        monitorConfig.verificationConfig.buy.delaySeconds,
        monitorConfig.verificationConfig.sell.delaySeconds,
      ),
    ),
  );
  const indicatorCache = createIndicatorCache({
    maxEntries: maxDelaySeconds + 15 + 10,
  });
  const buyTaskQueue = createBuyTaskQueue();
  const sellTaskQueue = createSellTaskQueue();
  const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();

  return {
    liquidationCooldownTracker,
    dailyLossTracker,
    protectiveLiquidationEpisodeTracker,
    monitorContexts,
    tradingRiskEventRuntime,
    monitorQuoteEventRuntime,
    switchWakeupRuntime,
    postTradeConsistencyRuntime,
    lastState,
    trader,
    tradeLogHydrator,
    loadTradingDayRuntimeSnapshot,
    marketMonitor,
    doomsdayProtection,
    signalProcessor,
    indicatorCache,
    buyTaskQueue,
    sellTaskQueue,
    monitorTaskQueue,
  };
}

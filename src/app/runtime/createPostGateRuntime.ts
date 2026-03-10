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
import { createLossOffsetLifecycleCoordinator } from '../../core/riskController/lossOffsetLifecycleCoordinator/index.js';
import { createDoomsdayProtection } from '../../core/doomsdayProtection/index.js';
import { createSignalProcessor } from '../../core/signalProcessor/index.js';
import { createIndicatorCache } from '../../main/asyncProgram/indicatorCache/index.js';
import { createMonitorTaskQueue } from '../../main/asyncProgram/monitorTaskQueue/index.js';
import {
  createBuyTaskQueue,
  createSellTaskQueue,
} from '../../main/asyncProgram/tradeTaskQueue/index.js';
import { createLoadTradingDayRuntimeSnapshot } from '../../main/lifecycle/loadTradingDayRuntimeSnapshot.js';
import { createMarketMonitor } from '../../services/marketMonitor/index.js';
import { createLiquidationCooldownTracker } from '../../services/liquidationCooldown/index.js';
import { createTradeLogHydrator } from '../../services/liquidationCooldown/tradeLogHydrator.js';
import { createPositionCache } from '../../utils/positionCache/index.js';
import { createRefreshGate } from '../../utils/refreshGate/index.js';
import { initMonitorState } from '../../utils/helpers/index.js';
import { resolveLogRootDir } from '../../utils/runtime/index.js';
import { getHKDateKey, toHongKongTimeIso } from '../../utils/time/index.js';
import { logger } from '../../utils/logger/index.js';
import { isSeatReady } from '../../services/autoSymbolManager/utils.js';
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
  const monitorContexts = new Map<string, MonitorContext>();
  const monitorConfigMap = new Map(
    tradingConfig.monitors.map((monitorConfig) => [monitorConfig.monitorSymbol, monitorConfig]),
  );
  const refreshGate = createRefreshGate();
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
  const lossOffsetLifecycleCoordinator = createLossOffsetLifecycleCoordinator({
    liquidationCooldownTracker,
    dailyLossTracker,
    logger,
    resolveCooldownConfig: (monitorSymbol, _direction) => {
      const monitorConfig = monitorConfigMap.get(monitorSymbol);
      return monitorConfig?.liquidationCooldown ?? null;
    },
    onSegmentReset: async ({ monitorSymbol, direction }) => {
      const monitorContext = monitorContexts.get(monitorSymbol);
      if (!monitorContext) {
        return;
      }

      const seatState = monitorContext.symbolRegistry.getSeatState(monitorSymbol, direction);
      if (!isSeatReady(seatState)) {
        return;
      }

      const isLongSymbol = direction === 'LONG';
      const quote = isLongSymbol ? monitorContext.longQuote : monitorContext.shortQuote;
      const dailyLossOffset = dailyLossTracker.getLossOffset(monitorSymbol, isLongSymbol);
      await monitorContext.riskChecker.refreshUnrealizedLossData(
        monitorContext.orderRecorder,
        seatState.symbol,
        isLongSymbol,
        quote,
        dailyLossOffset,
      );
    },
  });
  const trader = await createTrader({
    config,
    tradingConfig,
    liquidationCooldownTracker,
    symbolRegistry,
    dailyLossTracker,
    refreshGate,
    isExecutionAllowed: () => lastState.isTradingEnabled,
  });
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
    tradeLogHydrator,
    warrantListCacheConfig,
  });
  const marketMonitor = createMarketMonitor();
  const doomsdayProtection = createDoomsdayProtection();
  const signalProcessor = createSignalProcessor({
    tradingConfig,
    liquidationCooldownTracker,
    syncLossOffsetLifecycle: lossOffsetLifecycleCoordinator.sync,
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
    monitorContexts,
    lossOffsetLifecycleCoordinator,
    refreshGate,
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

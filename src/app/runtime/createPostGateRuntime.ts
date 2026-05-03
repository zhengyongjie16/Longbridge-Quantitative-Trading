/**
 * app post-gate runtime 工厂模块
 *
 * 职责：
 * - 创建 startup gate 之后才能初始化的共享运行时对象
 * - 固定 lastState、trader、快照加载器与异步基础设施的唯一创建点
 * - 保持 post-gate 对象所有权清单集中
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  INDICATOR_CACHE,
  LOGGING,
  PERIODIC_SWITCH_WAKEUP,
  TIME,
  TRADING,
  VERIFICATION,
} from '../../constants/index.js';
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
import { createAutoSearchWakeupRuntime } from '../../main/autoSearchWakeupRuntime/index.js';
import { createQuoteSubscriptionRuntime } from '../../main/quoteSubscriptionRuntime/index.js';
import { createSeatActivationDispatcher } from '../../main/seatActivationDispatcher/index.js';
import { createSeatRuntimeCleanupDispatcher } from '../../main/seatRuntimeCleanupDispatcher/index.js';
import { createTradingGateEventRuntime } from '../../main/tradingGateEventRuntime/index.js';
import { createPeriodicSwitchWakeupRuntime } from '../../main/periodicSwitchWakeupRuntime/index.js';
import { createDefaultMonitorQuoteEventRuntime } from '../../main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.js';
import { createSwitchWakeupRuntime } from '../../main/monitorQuoteEventRuntime/switchWakeupRuntime.js';
import { createMonitorDisplayRuntime } from '../../main/monitorDisplayRuntime/index.js';
import { createTradingQuoteDisplayRuntime } from '../../main/tradingQuoteDisplayRuntime/index.js';
import { createMarketMonitor } from '../../services/marketMonitor/index.js';
import { buildPriceDisplayInfo } from '../../services/marketMonitor/priceDisplayInfo.js';
import { createLiquidationCooldownTracker } from '../../services/liquidationCooldown/index.js';
import { createTradeLogHydrator } from '../../services/liquidationCooldown/tradeLogHydrator.js';
import { createPositionCache } from '../../utils/positionCache/index.js';
import { initMonitorState, isValidPositiveNumber } from '../../utils/helpers/index.js';
import { resolveLogRootDir } from '../../utils/runtime/index.js';
import { buildTradeLogPath } from '../../utils/trading/tradeLogPath.js';
import {
  calculateTradingDurationDueAtMs,
  getRequiredHKDateKey,
  toHongKongTimeIso,
} from '../../utils/time/index.js';
import { logger, retainLatestLogFiles } from '../../utils/logger/index.js';
import type { LastState, MonitorContext } from '../../types/state.js';
import type { OrderStateChangedEvent } from '../../types/services.js';
import type { MonitorTaskDataMap } from '../../main/asyncProgram/monitorTaskProcessor/types.js';
import type { QuoteSubscriptionRuntime } from '../../main/quoteSubscriptionRuntime/types.js';
import type {
  CreatePostGateRuntimeParams,
  MutableMonitorContextsPostGateRuntime,
  PersistableTradeRecord,
} from '../types.js';
import type { CreatePostGateRuntimeDeps } from './types.js';

const DEFAULT_CREATE_POST_GATE_RUNTIME_DEPS: CreatePostGateRuntimeDeps = {
  createTrader,
};

function hasPersistableTradeExecutionContext(
  event: OrderStateChangedEvent,
): event is OrderStateChangedEvent & {
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  readonly isLongSymbol: boolean;
  readonly executedPrice: number;
  readonly executedQuantity: number;
  readonly executedTimeMs: number;
} {
  return (
    event.symbol !== null &&
    event.side !== null &&
    event.isLongSymbol !== null &&
    isValidPositiveNumber(event.executedPrice) &&
    isValidPositiveNumber(event.executedQuantity) &&
    isValidPositiveNumber(event.executedTimeMs)
  );
}

function resolveTradeAction(params: {
  readonly side: 'BUY' | 'SELL';
  readonly isLongSymbol: boolean;
}): 'BUYCALL' | 'BUYPUT' | 'SELLCALL' | 'SELLPUT' {
  const { side, isLongSymbol } = params;
  if (side === 'BUY') {
    return isLongSymbol ? 'BUYCALL' : 'BUYPUT';
  }

  return isLongSymbol ? 'SELLCALL' : 'SELLPUT';
}

function resolveTradeReason(
  event: OrderStateChangedEvent & { readonly side: 'BUY' | 'SELL' },
): string | null {
  if (event.isProtectiveLiquidation && event.side === 'SELL' && event.status === 'FILLED') {
    return TRADING.PROTECTIVE_LIQUIDATION_COMPLETED_REASON;
  }

  if (event.status === 'FILLED') {
    return null;
  }

  return event.status;
}

/**
 * 根据订单状态变化事件构造可持久化的 TradeRecord。
 *
 * @param event 订单状态变化事件
 * @returns 可写入 trade log 的记录；事件上下文不足时返回 null
 */
function resolveTradeRecordFromOrderStateChangedEvent(
  event: OrderStateChangedEvent,
): PersistableTradeRecord | null {
  if (!hasPersistableTradeExecutionContext(event)) {
    return null;
  }

  return {
    orderId: event.orderId,
    symbol: event.symbol,
    symbolName: null,
    monitorSymbol: event.monitorSymbol,
    action: resolveTradeAction({
      side: event.side,
      isLongSymbol: event.isLongSymbol,
    }),
    side: event.side,
    quantity: String(event.executedQuantity),
    price: String(event.executedPrice),
    orderType: null,
    status: 'FILLED',
    error: null,
    reason: resolveTradeReason(event),
    signalTriggerTime: null,
    executedAt: toHongKongTimeIso(new Date(event.executedTimeMs)),
    executedAtMs: event.executedTimeMs,
    timestamp: toHongKongTimeIso(),
    isProtectiveClearance: event.isProtectiveLiquidation,
  };
}

/**
 * 处理订单状态事件并持久化 trade log。
 *
 * @param params 运行时环境与订单状态事件
 */
function persistTradeRecordFromOrderStateChangedEvent(params: {
  readonly env: NodeJS.ProcessEnv;
  readonly event: OrderStateChangedEvent;
}): void {
  const tradeRecord = resolveTradeRecordFromOrderStateChangedEvent(params.event);
  if (tradeRecord === null) {
    return;
  }

  const logRootDir = resolveLogRootDir(params.env);
  const logDir = path.join(logRootDir, 'trades');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const logFile = buildTradeLogPath(logRootDir, new Date(tradeRecord.executedAtMs));
  retainLatestLogFiles(logDir, LOGGING.MAX_RETAINED_LOG_FILES, 'json', path.basename(logFile));

  let records: unknown[] = [];
  if (fs.existsSync(logFile)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(logFile, 'utf8'));
      if (Array.isArray(parsed)) {
        records = parsed;
      }
    } catch (error) {
      logger.warn('[createPostGateRuntime] 解析 trade log 失败，重置为空数组', error);
      records = [];
    }
  }

  records.push(tradeRecord);
  fs.writeFileSync(logFile, JSON.stringify(records, null, 2), 'utf8');
}

/**
 * 创建 post-gate runtime 工厂。
 *
 * @param deps post-gate 创建链路中的可注入依赖
 * @returns post-gate runtime 创建函数
 */
export function createPostGateRuntimeFactory(
  deps: CreatePostGateRuntimeDeps,
): (params: CreatePostGateRuntimeParams) => Promise<MutableMonitorContextsPostGateRuntime> {
  const { createTrader: buildTrader } = deps;

  return async function createPostGateRuntime(
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
    const liquidationCooldownTracker = createLiquidationCooldownTracker({
      nowMs: () => Date.now(),
    });
    const dailyLossTracker = createDailyLossTracker({
      filteringEngine: createOrderFilteringEngine(),
      resolveOrderOwnership,
      classifyAndConvertOrders,
      toHongKongTimeIso,
    });
    const protectiveLiquidationEpisodeTracker = createProtectiveLiquidationEpisodeTracker();
    const monitorContexts = new Map<string, MonitorContext>();
    const initialDayKey = getRequiredHKDateKey(now);
    const initialTradingDayInfo =
      startupTradingDayInfo !== null && startupTradingDayInfo.dateKey === initialDayKey
        ? startupTradingDayInfo.info
        : null;
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
      cachedTradingDayInfo:
        initialTradingDayInfo === null
          ? null
          : {
              dateKey: initialDayKey,
              info: initialTradingDayInfo,
            },
      tradingCalendarSnapshot:
        initialTradingDayInfo === null
          ? new Map()
          : new Map([[initialDayKey, initialTradingDayInfo]]),
      monitorStates: new Map(
        tradingConfig.monitors.map((monitorConfig) => [
          monitorConfig.monitorSymbol,
          initMonitorState(monitorConfig),
        ]),
      ),
      allTradingSymbols: new Set(),
    };
    let traderRef: Awaited<ReturnType<typeof createTrader>> | null = null;
    let quoteSubscriptionRuntimeRef: QuoteSubscriptionRuntime | null = null;
    const postTradeConsistencyRuntime = createPostTradeConsistencyRuntime({
      getTrader: () => {
        if (traderRef === null) {
          throw new Error('[postTradeConsistencyRuntime] Trader 尚未初始化');
        }

        return traderRef;
      },
      lastState,
      onPositionsCommitted: async () => {
        await quoteSubscriptionRuntimeRef?.reconcilePositionHoldFromCurrentTruth();
      },
    });
    const trader = await buildTrader({
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
    trader.onOrderStateChanged((event) => {
      persistTradeRecordFromOrderStateChangedEvent({
        env,
        event,
      });
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
      protectiveLiquidationEpisodeTracker,
      tradeLogHydrator,
      warrantListCacheConfig,
    });
    const marketMonitor = createMarketMonitor();
    const doomsdayProtection = createDoomsdayProtection();
    const doomsdayProtectionEnabled = tradingConfig.global.doomsdayProtection;
    const tradingGateEventRuntime = createTradingGateEventRuntime();
    const quoteSubscriptionRuntime = createQuoteSubscriptionRuntime({
      tradingConfig,
      symbolRegistry,
      marketDataClient,
      trader,
      lastState,
    });
    quoteSubscriptionRuntimeRef = quoteSubscriptionRuntime;
    const tradingRiskEventRuntime = createTradingRiskEventRuntime({
      marketDataClient,
      trader,
      symbolRegistry,
      monitorContexts,
      lastState,
      postTradeConsistencyRuntime,
      doomsdayProtectionEnabled,
      now: () => new Date(),
    });
    const switchWakeupRuntime = createSwitchWakeupRuntime({
      marketDataClient,
      trader,
      symbolRegistry,
      monitorContexts,
      lastState,
      postTradeConsistencyRuntime,
      doomsdayProtectionEnabled,
      quoteSubscriptionRuntime,
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
      doomsdayProtectionEnabled,
      quoteSubscriptionRuntime,
      now: () => new Date(),
      handoffPendingSwitch: switchWakeupRuntime.handoffPendingSwitch,
    });
    const monitorDisplayRuntime = createMonitorDisplayRuntime({
      marketDataClient,
      monitorContexts,
      lastState,
      marketMonitor,
    });
    const tradingQuoteDisplayRuntime = createTradingQuoteDisplayRuntime({
      marketDataClient,
      symbolRegistry,
      monitorContexts,
      lastState,
      renderTradingQuote: (renderParams) => {
        const monitorContext = monitorContexts.get(renderParams.monitorSymbol);
        if (monitorContext === undefined) {
          return;
        }

        const displayInfo = buildPriceDisplayInfo({
          seatActive: true,
          symbol: renderParams.tradingSymbol,
          monitorCurrentPrice: renderParams.monitorQuote?.price ?? null,
          quotePrice: renderParams.event.quote.price,
          isLongSymbol: renderParams.direction === 'LONG',
          riskChecker: monitorContext.riskChecker,
          orderRecorder: monitorContext.orderRecorder,
        });
        marketMonitor.renderTradingQuote({
          ...renderParams,
          displayInfo,
        });
      },
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
    const indicatorCacheRetentionSeconds =
      maxDelaySeconds +
      VERIFICATION.READY_DELAY_SECONDS +
      INDICATOR_CACHE.RETENTION_SAFETY_MARGIN_SECONDS;
    // 额外保留缓存安全余量，确保延迟验证读取最近样本时窗口充足。
    const indicatorCache = createIndicatorCache({
      retentionWindowMs: indicatorCacheRetentionSeconds * TIME.MILLISECONDS_PER_SECOND,
    });
    const buyTaskQueue = createBuyTaskQueue();
    const sellTaskQueue = createSellTaskQueue();
    const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();
    const seatActivationDispatcher = createSeatActivationDispatcher({
      tradingConfig,
      symbolRegistry,
      monitorTaskQueue,
    });
    const seatRuntimeCleanupDispatcher = createSeatRuntimeCleanupDispatcher({
      symbolRegistry,
      monitorContexts,
      buyTaskQueue,
      sellTaskQueue,
      monitorTaskQueue,
    });
    const autoSearchWakeupRuntime = createAutoSearchWakeupRuntime({
      tradingConfig,
      symbolRegistry,
      monitorContexts,
      lastState,
      tradingGateEventRuntime,
      now: () => new Date(),
      scheduleTimer: (callback, delayMs) => {
        return setTimeout(callback, delayMs);
      },
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
    });
    const periodicSwitchWakeupRuntime = createPeriodicSwitchWakeupRuntime({
      tradingConfig,
      monitorContexts,
      symbolRegistry,
      monitorTaskQueue,
      trader,
      postTradeConsistencyRuntime,
      tradingGateEventRuntime,
      calculateDueAtMs: ({ startMs, switchIntervalMinutes }) =>
        calculateTradingDurationDueAtMs({
          startMs,
          targetDurationMs: switchIntervalMinutes * TIME.MILLISECONDS_PER_MINUTE,
          calendarSnapshot: lastState.tradingCalendarSnapshot ?? new Map(),
        }),
      taskFailureRetryDelayMs: PERIODIC_SWITCH_WAKEUP.TASK_FAILURE_RETRY_DELAY_MS,
      now: () => new Date(),
      scheduleTimer: (callback, delayMs) => {
        return setTimeout(callback, delayMs);
      },
      clearTimer: (handle) => {
        clearTimeout(handle);
      },
    });

    return {
      liquidationCooldownTracker,
      dailyLossTracker,
      protectiveLiquidationEpisodeTracker,
      monitorContexts,
      tradingGateEventRuntime,
      quoteSubscriptionRuntime,
      seatActivationDispatcher,
      seatRuntimeCleanupDispatcher,
      autoSearchWakeupRuntime,
      periodicSwitchWakeupRuntime,
      tradingRiskEventRuntime,
      monitorQuoteEventRuntime,
      monitorDisplayRuntime,
      tradingQuoteDisplayRuntime,
      switchWakeupRuntime,
      postTradeConsistencyRuntime,
      lastState,
      trader,
      loadTradingDayRuntimeSnapshot,
      doomsdayProtection,
      signalProcessor,
      indicatorCache,
      buyTaskQueue,
      sellTaskQueue,
      monitorTaskQueue,
    };
  };
}

export const createPostGateRuntime = createPostGateRuntimeFactory(
  DEFAULT_CREATE_POST_GATE_RUNTIME_DEPS,
);

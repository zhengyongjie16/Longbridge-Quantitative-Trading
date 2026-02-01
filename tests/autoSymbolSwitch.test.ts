import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMonitorTaskProcessor } from '../src/main/asyncProgram/monitorTaskProcessor/index.js';
import { createMonitorTaskQueue } from '../src/main/asyncProgram/monitorTaskQueue/index.js';
import { createAutoSymbolManager } from '../src/services/autoSymbolManager/index.js';
import { createSymbolRegistry } from '../src/services/autoSymbolManager/utils.js';

import type { RefreshGate } from '../src/utils/refreshGate/types.js';
import type { DailyLossTracker } from '../src/core/risk/types.js';
import type { UnrealizedLossMonitor } from '../src/core/unrealizedLossMonitor/types.js';
import type {
  AutoSymbolManager,
  SeatDirection,
} from '../src/services/autoSymbolManager/types.js';
import type {
  AutoSymbolSwitchDistanceTaskData,
  MonitorTaskContext,
  MonitorTaskData,
  MonitorTaskProcessorDeps,
  MonitorTaskType,
} from '../src/main/asyncProgram/monitorTaskProcessor/types.js';
import type {
  LastState,
  MarketDataClient,
  MonitorConfig,
  MultiMonitorTradingConfig,
  OrderRecorder,
  PositionCache,
  Quote,
  RiskCheckResult,
  RiskChecker,
  SeatState,
  SymbolRegistry,
  TradeCheckResult,
  TradingDayInfo,
  UnrealizedLossCheckResult,
  WarrantDistanceInfo,
  WarrantDistanceLiquidationResult,
  WarrantRefreshResult,
} from '../src/types/index.js';
import type { Trader } from '../src/types/index.js';

const ignoreArgs = (...args: ReadonlyArray<unknown>): void => {
  void args;
};

const resolveVoid = async (...args: ReadonlyArray<unknown>): Promise<void> => {
  void args;
};

const resolveNull = async (...args: ReadonlyArray<unknown>): Promise<null> => {
  void args;
  return null;
};

const resolveEmptyArray = async <T>(...args: ReadonlyArray<unknown>): Promise<T[]> => {
  void args;
  return [];
};

const returnNull = (...args: ReadonlyArray<unknown>): null => {
  void args;
  return null;
};

const returnFalse = (...args: ReadonlyArray<unknown>): boolean => {
  void args;
  return false;
};

const returnZero = (...args: ReadonlyArray<unknown>): number => {
  void args;
  return 0;
};

const returnEmptyArray = <T>(...args: ReadonlyArray<unknown>): T[] => {
  void args;
  return [];
};

function createStubOrderRecorder(): OrderRecorder {
  return {
    recordLocalBuy: ignoreArgs,
    recordLocalSell: ignoreArgs,
    clearBuyOrders: ignoreArgs,
    getLatestBuyOrderPrice: returnNull,
    getLatestSellRecord: returnNull,
    getBuyOrdersBelowPrice: returnEmptyArray,
    calculateTotalQuantity: returnZero,
    fetchAllOrdersFromAPI: resolveEmptyArray,
    refreshOrdersFromAllOrders: resolveEmptyArray,
    clearOrdersCacheForSymbol: ignoreArgs,
    hasCacheForSymbols: returnFalse,
    getPendingOrdersFromCache: returnEmptyArray,
    getLongBuyOrders: returnEmptyArray,
    getShortBuyOrders: returnEmptyArray,
    getBuyOrdersForSymbol: returnEmptyArray,
  };
}

function createStubTrader(orderRecorder: OrderRecorder): Trader {
  return {
    _ctxPromise: new Promise<import('longport').TradeContext>(() => {}),
    _orderRecorder: orderRecorder,
    getAccountSnapshot: resolveNull,
    getStockPositions: resolveEmptyArray,
    getPendingOrders: resolveEmptyArray,
    seedOrderHoldSymbols: ignoreArgs,
    getOrderHoldSymbols: () => new Set<string>(),
    clearPendingOrdersCache: ignoreArgs,
    hasPendingBuyOrders: async (): Promise<boolean> => false,
    trackOrder: ignoreArgs,
    cancelOrder: async (): Promise<boolean> => true,
    replaceOrderPrice: resolveVoid,
    monitorAndManageOrders: resolveVoid,
    getAndClearPendingRefreshSymbols: () => [],
    _canTradeNow: (): TradeCheckResult => ({ canTrade: true }),
    _markBuyAttempt: ignoreArgs,
    executeSignals: resolveVoid,
  };
}

function createStubMarketDataClient(): MarketDataClient {
  return {
    _getContext: async (): Promise<import('longport').QuoteContext> => {
      throw new Error('not implemented');
    },
    getQuotes: async (): Promise<Map<string, Quote | null>> => new Map<string, Quote | null>(),
    subscribeSymbols: resolveVoid,
    unsubscribeSymbols: resolveVoid,
    getCandlesticks: resolveEmptyArray,
    getTradingDays: async (): Promise<{ tradingDays: string[]; halfTradingDays: string[] }> => ({
      tradingDays: [],
      halfTradingDays: [],
    }),
    isTradingDay: async (): Promise<TradingDayInfo> => ({
      isTradingDay: false,
      isHalfDay: false,
    }),
    cacheStaticInfo: resolveVoid,
  };
}

function createStubRiskChecker(): RiskChecker {
  return {
    unrealizedLossData: new Map<string, import('../src/types/index.js').UnrealizedLossData>(),
    initializeWarrantInfo: resolveVoid,
    refreshWarrantInfoForSymbol: async (): Promise<WarrantRefreshResult> => ({
      status: 'skipped',
      isWarrant: false,
    }),
    checkBeforeOrder: (): RiskCheckResult => ({ allowed: true }),
    checkWarrantRisk: (): RiskCheckResult => ({ allowed: true }),
    checkWarrantDistanceLiquidation: (): WarrantDistanceLiquidationResult => ({
      shouldLiquidate: false,
    }),
    getWarrantDistanceInfo: (): WarrantDistanceInfo | null => null,
    clearWarrantInfo: ignoreArgs,
    refreshUnrealizedLossData: async (): Promise<{ r1: number; n1: number } | null> => null,
    checkUnrealizedLoss: (): UnrealizedLossCheckResult => ({ shouldLiquidate: false }),
  };
}

function createStubDailyLossTracker(): DailyLossTracker {
  return {
    initializeFromOrders: ignoreArgs,
    recalculateFromAllOrders: ignoreArgs,
    recordFilledOrder: ignoreArgs,
    getLossOffset: returnZero,
    resetIfNewDay: ignoreArgs,
  };
}

function createStubUnrealizedLossMonitor(): UnrealizedLossMonitor {
  return {
    monitorUnrealizedLoss: resolveVoid,
  };
}

function createStubRefreshGate(): RefreshGate {
  let currentVersion = 0;
  let staleVersion = 0;
  return {
    markStale: (): number => {
      staleVersion += 1;
      return staleVersion;
    },
    markFresh: (version: number): void => {
      currentVersion = version;
    },
    waitForFresh: resolveVoid,
    getStatus: (): { currentVersion: number; staleVersion: number } => ({
      currentVersion,
      staleVersion,
    }),
  };
}

function createStubPositionCache(): PositionCache {
  let version = 0;
  return {
    update: (): void => {
      version += 1;
    },
    get: returnNull,
    getVersion: (): number => version,
    getAll: returnEmptyArray,
  };
}

function createStubLastState(): LastState {
  return {
    canTrade: null,
    isHalfDay: null,
    openProtectionActive: null,
    currentDayKey: null,
    cachedAccount: null,
    cachedPositions: [],
    positionCache: createStubPositionCache(),
    cachedTradingDayInfo: null,
    monitorStates: new Map(),
    allTradingSymbols: new Set(),
  };
}

function createMinimalMonitorConfig(monitorSymbol: string): MonitorConfig {
  return {
    originalIndex: 1,
    monitorSymbol,
    longSymbol: `${monitorSymbol}.LONG`,
    shortSymbol: `${monitorSymbol}.SHORT`,
    autoSearchConfig: {
      autoSearchEnabled: true,
      autoSearchMinPriceBull: 0,
      autoSearchMinPriceBear: 0,
      autoSearchMinTurnoverPerMinuteBull: 0,
      autoSearchMinTurnoverPerMinuteBear: 0,
      autoSearchExpiryMinMonths: 1,
      autoSearchOpenDelayMinutes: 0,
      switchDistanceRangeBull: { min: 0, max: 100 },
      switchDistanceRangeBear: { min: 0, max: 100 },
    },
    targetNotional: 1000,
    maxPositionNotional: 0,
    maxDailyLoss: 0,
    maxUnrealizedLossPerSymbol: 0,
    buyIntervalSeconds: 0,
    liquidationCooldown: null,
    verificationConfig: {
      buy: { delaySeconds: 0, indicators: null },
      sell: { delaySeconds: 0, indicators: null },
    },
    signalConfig: {
      buycall: null,
      sellcall: null,
      buyput: null,
      sellput: null,
    },
    smartCloseEnabled: false,
  };
}

function createMinimalTradingConfig(monitorConfig: MonitorConfig): MultiMonitorTradingConfig {
  return {
    monitors: [monitorConfig],
    global: {
      doomsdayProtection: false,
      debug: false,
      openProtection: { enabled: false, minutes: null },
      orderMonitorPriceUpdateInterval: 0,
      tradingOrderType: 'LO',
      liquidationOrderType: 'MO',
      buyOrderTimeout: { enabled: false, timeoutSeconds: 0 },
      sellOrderTimeout: { enabled: false, timeoutSeconds: 0 },
    },
  };
}

function createStubSymbolRegistry(longSeat: SeatState, shortSeat: SeatState): SymbolRegistry {
  let longState = longSeat;
  let shortState = shortSeat;
  let longVersion = 1;
  let shortVersion = 1;
  return {
    getSeatState: (monitorSymbol: string, direction: 'LONG' | 'SHORT'): SeatState => {
      void monitorSymbol;
      return direction === 'LONG' ? longState : shortState;
    },
    getSeatVersion: (monitorSymbol: string, direction: 'LONG' | 'SHORT'): number => {
      void monitorSymbol;
      return direction === 'LONG' ? longVersion : shortVersion;
    },
    resolveSeatBySymbol: (symbol: string) => {
      void symbol;
      return null;
    },
    updateSeatState: (monitorSymbol: string, direction: 'LONG' | 'SHORT', nextState: SeatState) => {
      void monitorSymbol;
      if (direction === 'LONG') {
        longState = nextState;
      } else {
        shortState = nextState;
      }
      return nextState;
    },
    bumpSeatVersion: (monitorSymbol: string, direction: 'LONG' | 'SHORT') => {
      void monitorSymbol;
      if (direction === 'LONG') {
        longVersion += 1;
        return longVersion;
      }
      shortVersion += 1;
      return shortVersion;
    },
  };
}

async function waitForTaskProcessed(
  deps: MonitorTaskProcessorDeps,
  queue: ReturnType<typeof createMonitorTaskQueue<MonitorTaskType, MonitorTaskData>>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let processor: ReturnType<typeof createMonitorTaskProcessor> | null = null;
    const timeout = setTimeout(() => {
      processor?.stop();
      reject(new Error('timeout waiting for task processing'));
    }, 1000);

    processor = createMonitorTaskProcessor({
      ...deps,
      monitorTaskQueue: queue,
      onProcessed: () => {
        clearTimeout(timeout);
        processor?.stop();
        resolve();
      },
    });

    processor.start();
  });
}

test('MonitorTaskProcessor calls maybeSwitchOnDistance when seat is SWITCHING', async () => {
  const monitorSymbol = 'MONITOR.SWITCH';
  const longSeat: SeatState = {
    symbol: 'LONG.SWITCH',
    status: 'SWITCHING',
    lastSwitchAt: 1,
    lastSearchAt: null,
  };
  const shortSeat: SeatState = {
    symbol: null,
    status: 'EMPTY',
    lastSwitchAt: null,
    lastSearchAt: null,
  };
  const symbolRegistry = createStubSymbolRegistry(longSeat, shortSeat);
  const calledDirections: SeatDirection[] = [];
  const autoSymbolManager: AutoSymbolManager = {
    ensureSeatOnStartup: () => longSeat,
    maybeSearchOnTick: resolveVoid,
    maybeSwitchOnDistance: async ({ direction }): Promise<void> => {
      calledDirections.push(direction);
    },
    clearSeat: (): number => 1,
    resetDailySwitchSuppression: () => {},
    hasPendingSwitch: () => false,
  };

  const context: MonitorTaskContext = {
    symbolRegistry,
    autoSymbolManager,
    orderRecorder: createStubOrderRecorder(),
    dailyLossTracker: createStubDailyLossTracker(),
    riskChecker: createStubRiskChecker(),
    unrealizedLossMonitor: createStubUnrealizedLossMonitor(),
    longSymbolName: 'LONG',
    shortSymbolName: 'SHORT',
    monitorSymbolName: 'MONITOR',
    longQuote: null,
    shortQuote: null,
    monitorQuote: null,
  };

  const monitorConfig = createMinimalMonitorConfig(monitorSymbol);
  const queue = createMonitorTaskQueue<MonitorTaskType, MonitorTaskData>();
  const refreshGate = createStubRefreshGate();
  const marketDataClient = createStubMarketDataClient();
  const lastState = createStubLastState();
  const orderRecorder = createStubOrderRecorder();
  const trader = createStubTrader(orderRecorder);
  const tradingConfig = createMinimalTradingConfig(monitorConfig);

  const deps: MonitorTaskProcessorDeps = {
    monitorTaskQueue: queue,
    refreshGate,
    getMonitorContext: (symbol: string): MonitorTaskContext | null => {
      void symbol;
      return context;
    },
    clearQueuesForDirection: ignoreArgs,
    marketDataClient,
    trader,
    lastState,
    tradingConfig,
  };

  const taskData: AutoSymbolSwitchDistanceTaskData = {
    monitorSymbol,
    monitorPrice: 123,
    quotesMap: new Map<string, Quote | null>(),
    seatSnapshots: {
      long: {
        seatVersion: 1,
        symbol: longSeat.symbol,
      },
      short: {
        seatVersion: 1,
        symbol: shortSeat.symbol,
      },
    },
  };

  queue.scheduleLatest({
    type: 'AUTO_SYMBOL_SWITCH_DISTANCE',
    dedupeKey: `${monitorSymbol}:AUTO_SYMBOL_SWITCH_DISTANCE`,
    monitorSymbol,
    data: taskData,
  });

  await waitForTaskProcessed(deps, queue);

  assert.deepEqual(calledDirections, ['LONG']);
});

test('autoSymbolManager.hasPendingSwitch returns true after clearSeat', () => {
  const monitorSymbol = 'MONITOR.PENDING';
  const monitorConfig = createMinimalMonitorConfig(monitorSymbol);
  const symbolRegistry = createSymbolRegistry([monitorConfig]);
  const orderRecorder = createStubOrderRecorder();
  const trader = createStubTrader(orderRecorder);

  const autoSymbolManager = createAutoSymbolManager({
    monitorConfig,
    symbolRegistry,
    marketDataClient: createStubMarketDataClient(),
    trader,
    orderRecorder,
    riskChecker: createStubRiskChecker(),
    now: () => new Date('2026-02-01T00:00:00.000Z'),
  });

  symbolRegistry.updateSeatState(monitorSymbol, 'LONG', {
    symbol: 'LONG.OLD',
    status: 'READY',
    lastSwitchAt: null,
    lastSearchAt: null,
  });

  autoSymbolManager.clearSeat({ direction: 'LONG', reason: 'test' });

  const hasPendingSwitch = autoSymbolManager.hasPendingSwitch('LONG');
  assert.equal(hasPendingSwitch, true);
});

test('autoSymbolManager clears switchState when seatState mismatches', () => {
  const monitorSymbol = 'MONITOR.MISMATCH';
  const monitorConfig = createMinimalMonitorConfig(monitorSymbol);
  const symbolRegistry = createSymbolRegistry([monitorConfig]);
  const orderRecorder = createStubOrderRecorder();
  const trader = createStubTrader(orderRecorder);

  const autoSymbolManager = createAutoSymbolManager({
    monitorConfig,
    symbolRegistry,
    marketDataClient: createStubMarketDataClient(),
    trader,
    orderRecorder,
    riskChecker: createStubRiskChecker(),
    now: () => new Date('2026-02-01T00:00:00.000Z'),
  });

  symbolRegistry.updateSeatState(monitorSymbol, 'LONG', {
    symbol: 'OLD',
    status: 'READY',
    lastSwitchAt: null,
    lastSearchAt: null,
  });

  autoSymbolManager.clearSeat({ direction: 'LONG', reason: 'test mismatch' });

  symbolRegistry.updateSeatState(monitorSymbol, 'LONG', {
    symbol: 'DIFF',
    status: 'SWITCHING',
    lastSwitchAt: 1,
    lastSearchAt: null,
  });

  assert.equal(autoSymbolManager.hasPendingSwitch('LONG'), false);

  symbolRegistry.updateSeatState(monitorSymbol, 'LONG', {
    symbol: 'OLD',
    status: 'SWITCHING',
    lastSwitchAt: 2,
    lastSearchAt: null,
  });

  assert.equal(autoSymbolManager.hasPendingSwitch('LONG'), false);
});

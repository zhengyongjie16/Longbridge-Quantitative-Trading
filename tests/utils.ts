import { createMonitorContext } from '../src/services/monitorContext/index.js';
import { createSymbolRegistry } from '../src/services/autoSymbolManager/utils.js';
import { createPositionCache } from '../src/utils/helpers/positionCache.js';
import { getHKDateKey } from '../src/utils/helpers/tradingTime.js';
import type { HangSengMultiIndicatorStrategy } from '../src/core/strategy/types.js';
import type {
  AutoSearchConfig,
  IndicatorSnapshot,
  LastState,
  MonitorConfig,
  MonitorState,
  MultiMonitorTradingConfig,
  Position,
  Quote,
  Signal,
  SignalConfig,
  SignalConfigSet,
  SingleVerificationConfig,
  TradingDayInfo,
} from '../src/types/index.js';
import type { AutoSymbolManager } from '../src/services/autoSymbolManager/types.js';
import type { DailyLossTracker } from '../src/core/risk/types.js';
import type { DelayedSignalVerifier } from '../src/main/asyncProgram/delayedSignalVerifier/types.js';
import type { OrderRecorder, RiskChecker } from '../src/types/index.js';
import type { UnrealizedLossMonitor } from '../src/core/unrealizedLossMonitor/types.js';
import type { SymbolRegistry } from '../src/types/index.js';

const createEmptySignalConfig = (): SignalConfig => ({
  conditionGroups: [],
});

const createDefaultVerificationConfig = (): {
  readonly buy: SingleVerificationConfig;
  readonly sell: SingleVerificationConfig;
} => ({
  buy: { delaySeconds: 0, indicators: ['K'] },
  sell: { delaySeconds: 0, indicators: ['K'] },
});

export const createMonitorConfig = (overrides: Partial<MonitorConfig> = {}): MonitorConfig => {
  const defaultSignalConfig = createEmptySignalConfig();
  const defaultSignalConfigSet: SignalConfigSet = {
    buycall: defaultSignalConfig,
    sellcall: defaultSignalConfig,
    buyput: defaultSignalConfig,
    sellput: defaultSignalConfig,
  };

  const defaultAutoSearchConfig: AutoSearchConfig = {
    autoSearchEnabled: false,
    autoSearchMinPriceBull: null,
    autoSearchMinPriceBear: null,
    autoSearchMinTurnoverPerMinuteBull: null,
    autoSearchMinTurnoverPerMinuteBear: null,
    autoSearchExpiryMinMonths: 3,
    autoSearchOpenDelayMinutes: 5,
    switchDistanceRangeBull: null,
    switchDistanceRangeBear: null,
  };

  const defaultVerificationConfig = createDefaultVerificationConfig();
  const mergedVerificationConfig = {
    buy: {
      ...defaultVerificationConfig.buy,
      ...(overrides.verificationConfig?.buy ?? {}),
    },
    sell: {
      ...defaultVerificationConfig.sell,
      ...(overrides.verificationConfig?.sell ?? {}),
    },
  };

  const mergedSignalConfig: SignalConfigSet = {
    buycall: overrides.signalConfig?.buycall ?? defaultSignalConfigSet.buycall,
    sellcall: overrides.signalConfig?.sellcall ?? defaultSignalConfigSet.sellcall,
    buyput: overrides.signalConfig?.buyput ?? defaultSignalConfigSet.buyput,
    sellput: overrides.signalConfig?.sellput ?? defaultSignalConfigSet.sellput,
  };

  return {
    originalIndex: 1,
    monitorSymbol: 'HSI.HK',
    longSymbol: 'BULL1.HK',
    shortSymbol: 'BEAR1.HK',
    autoSearchConfig: {
      ...defaultAutoSearchConfig,
      ...(overrides.autoSearchConfig ?? {}),
    },
    orderOwnershipMapping: [],
    targetNotional: 5000,
    maxPositionNotional: 200000,
    maxDailyLoss: 1000,
    maxUnrealizedLossPerSymbol: 500,
    buyIntervalSeconds: 60,
    liquidationCooldown: null,
    verificationConfig: mergedVerificationConfig,
    signalConfig: mergedSignalConfig,
    smartCloseEnabled: true,
    ...overrides,
  };
};

export const createTradingConfig = (
  overrides: Partial<MultiMonitorTradingConfig> = {},
): MultiMonitorTradingConfig => {
  const defaultGlobal = {
    doomsdayProtection: false,
    debug: false,
    openProtection: { enabled: false, minutes: null },
    orderMonitorPriceUpdateInterval: 1,
    tradingOrderType: 'ELO',
    liquidationOrderType: 'MO',
    buyOrderTimeout: { enabled: false, timeoutSeconds: 0 },
    sellOrderTimeout: { enabled: false, timeoutSeconds: 0 },
  } as const;

  const mergedGlobal = {
    ...defaultGlobal,
    ...(overrides.global ?? {}),
    openProtection: {
      ...defaultGlobal.openProtection,
      ...(overrides.global?.openProtection ?? {}),
    },
    buyOrderTimeout: {
      ...defaultGlobal.buyOrderTimeout,
      ...(overrides.global?.buyOrderTimeout ?? {}),
    },
    sellOrderTimeout: {
      ...defaultGlobal.sellOrderTimeout,
      ...(overrides.global?.sellOrderTimeout ?? {}),
    },
  };

  return {
    monitors: overrides.monitors ?? [createMonitorConfig()],
    global: mergedGlobal,
  };
};

export const createMonitorState = (monitorSymbol: string): MonitorState => ({
  monitorSymbol,
  monitorPrice: null,
  longPrice: null,
  shortPrice: null,
  signal: null,
  pendingDelayedSignals: [],
  monitorValues: null,
  lastMonitorSnapshot: null,
});

export const createLastState = (params: {
  readonly positions?: ReadonlyArray<Position>;
  readonly tradingDayInfo?: TradingDayInfo | null;
  readonly monitorStates?: ReadonlyMap<string, MonitorState>;
  readonly currentDayKey?: string | null;
} = {}): LastState => {
  const positions = params.positions ?? [];
  const positionCache = createPositionCache();
  positionCache.update(positions);

  return {
    canTrade: null,
    isHalfDay: null,
    openProtectionActive: null,
    currentDayKey: params.currentDayKey ?? getHKDateKey(new Date()),
    cachedAccount: null,
    cachedPositions: positions,
    positionCache,
    cachedTradingDayInfo: params.tradingDayInfo ?? null,
    monitorStates: params.monitorStates ?? new Map(),
    allTradingSymbols: new Set(),
  };
};

export const createQuote = (overrides: Partial<Quote> = {}): Quote => ({
  symbol: 'TEST.HK',
  name: 'TestSymbol',
  price: 1.23,
  prevClose: 1.2,
  timestamp: Date.now(),
  lotSize: 100,
  ...overrides,
});

export const createQuotesMap = (
  quotes: ReadonlyArray<Quote>,
): Map<string, Quote | null> => {
  const map = new Map<string, Quote | null>();
  for (const quote of quotes) {
    map.set(quote.symbol, quote);
  }
  return map;
};

export const createSignal = (overrides: Partial<Signal> = {}): Signal => ({
  symbol: 'BULL1.HK',
  symbolName: 'Bull',
  action: 'BUYCALL',
  reason: null,
  orderTypeOverride: null,
  isProtectiveLiquidation: null,
  price: null,
  lotSize: null,
  quantity: null,
  triggerTime: new Date(),
  seatVersion: 1,
  indicators1: null,
  verificationHistory: null,
  ...overrides,
});

export const createIndicatorSnapshot = (
  overrides: Partial<IndicatorSnapshot> = {},
): IndicatorSnapshot => ({
  price: overrides.price ?? 1,
  changePercent: overrides.changePercent ?? 0,
  ema: overrides.ema ?? null,
  rsi: overrides.rsi ?? null,
  psy: overrides.psy ?? null,
  mfi: overrides.mfi ?? null,
  kdj: overrides.kdj ?? null,
  macd: overrides.macd ?? null,
  ...(overrides.symbol !== undefined ? { symbol: overrides.symbol } : {}),
});

export const withMockedNow = <T>(timestamp: number, fn: () => T): T => {
  const realNow = Date.now;
  (Date as typeof Date & { now: () => number }).now = () => timestamp;
  try {
    return fn();
  } finally {
    (Date as typeof Date & { now: () => number }).now = realNow;
  }
};

export const withMockedDate = <T>(timestamp: number, fn: () => T): T => {
  const RealDate = Date;
  class MockDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        super(timestamp);
        return;
      }
      super(...(args as ConstructorParameters<typeof RealDate>));
    }
    static override now(): number {
      return timestamp;
    }
    static override parse(dateString: string): number {
      return RealDate.parse(dateString);
    }
    static override UTC(...args: Parameters<typeof RealDate.UTC>): number {
      return RealDate.UTC(...args);
    }
  }
  globalThis.Date = MockDate as typeof Date;
  try {
    return fn();
  } finally {
    globalThis.Date = RealDate;
  }
};

export const createMonitorContextForTest = (params: {
  readonly monitorConfig?: MonitorConfig;
  readonly symbolRegistry?: SymbolRegistry;
  readonly quotesMap?: Map<string, Quote | null>;
  readonly state?: MonitorState;
  readonly strategy?: HangSengMultiIndicatorStrategy;
  readonly orderRecorder?: OrderRecorder;
  readonly dailyLossTracker?: DailyLossTracker;
  readonly riskChecker?: RiskChecker;
  readonly unrealizedLossMonitor?: UnrealizedLossMonitor;
  readonly delayedSignalVerifier?: DelayedSignalVerifier;
  readonly autoSymbolManager?: AutoSymbolManager;
} = {}): {
  readonly context: ReturnType<typeof createMonitorContext>;
  readonly monitorConfig: MonitorConfig;
  readonly symbolRegistry: SymbolRegistry;
  readonly quotesMap: Map<string, Quote | null>;
  readonly state: MonitorState;
} => {
  const monitorConfig = params.monitorConfig ?? createMonitorConfig();
  const symbolRegistry = params.symbolRegistry ?? createSymbolRegistry([monitorConfig]);
  const state = params.state ?? createMonitorState(monitorConfig.monitorSymbol);
  const quotesMap = params.quotesMap ?? createQuotesMap([
    createQuote({ symbol: monitorConfig.monitorSymbol, name: 'Monitor', price: 20000 }),
    createQuote({ symbol: monitorConfig.longSymbol, name: 'LongSymbol', price: 1.1 }),
    createQuote({ symbol: monitorConfig.shortSymbol, name: 'ShortSymbol', price: 1.2 }),
  ]);

  const strategy = params.strategy ?? {
    generateCloseSignals: () => ({ immediateSignals: [], delayedSignals: [] }),
  };

  const orderRecorder = params.orderRecorder ?? ({} as OrderRecorder);

  const dailyLossTracker = params.dailyLossTracker ?? ({
    initializeFromOrders: () => undefined,
    recalculateFromAllOrders: () => undefined,
    recordFilledOrder: () => undefined,
    getLossOffset: () => 0,
    resetIfNewDay: () => undefined,
  } as DailyLossTracker);

  const riskChecker = params.riskChecker ?? ({
    clearWarrantInfo: () => undefined,
    getWarrantDistanceInfo: () => null,
    refreshUnrealizedLossData: async () => null,
    checkWarrantDistanceLiquidation: () => ({ shouldLiquidate: false }),
    refreshWarrantInfoForSymbol: async () => ({ status: 'ok' }),
  } as unknown as RiskChecker);

  const unrealizedLossMonitor = params.unrealizedLossMonitor ?? ({
    monitorUnrealizedLoss: async () => undefined,
  } as UnrealizedLossMonitor);

  const delayedSignalVerifier = params.delayedSignalVerifier ?? ({
    addSignal: () => undefined,
    cancelSignal: () => false,
    cancelAllForSymbol: () => undefined,
    cancelAllForDirection: () => 0,
    getPendingCount: () => 0,
    onVerified: () => undefined,
    onRejected: () => undefined,
    destroy: () => undefined,
  } as DelayedSignalVerifier);

  const autoSymbolManager = params.autoSymbolManager ?? ({
    ensureSeatOnStartup: () => ({ symbol: null, status: 'EMPTY', lastSwitchAt: null, lastSearchAt: null }),
    maybeSearchOnTick: async () => undefined,
    maybeSwitchOnDistance: async () => undefined,
    hasPendingSwitch: () => false,
    clearSeat: () => 1,
    resetDailySwitchSuppression: () => undefined,
  } as AutoSymbolManager);

  const context = createMonitorContext({
    config: monitorConfig,
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
  });

  return { context, monitorConfig, symbolRegistry, quotesMap, state };
};

/**
 * 测试替身与工厂（testDoubles）
 *
 * 功能：
 * - 提供测试替身与工厂方法，供其他测试模块使用
 */
import type { Position, AccountSnapshot } from '../../src/types/account.js';
import type { MonitorConfig } from '../../src/types/config.js';
import type { CandleData } from '../../src/types/data.js';
import type { Quote } from '../../src/types/quote.js';
import type { Signal, SignalType } from '../../src/types/signal.js';
import type {
  DisplayIndicatorItem,
  IndicatorUsageProfile,
  SignalIndicator,
  StrategyAction,
} from '../../src/types/indicatorProfile.js';
import type { MonitorContext, MonitorState } from '../../src/types/state.js';
import type {
  OrderRecorder,
  MarketDataClient,
  PendingOrder,
  PendingRefreshSymbol,
  PositionCache,
  RiskChecker,
  RiskCheckResult,
  Trader,
  WarrantDistanceInfo,
  WarrantDistanceLiquidationResult,
  WarrantRefreshResult,
  CandlestickCacheSnapshot,
} from '../../src/types/services.js';
import type { SymbolRegistry, SeatState } from '../../src/types/seat.js';
import type { Candlestick, Config, Period, QuoteContext, TradeContext } from 'longbridge';
import type { TradingSignalStrategy } from '../../src/core/strategy/types.js';
import type {
  DoomsdayProtection,
  DoomsdayClearanceContext,
  DoomsdayClearanceResult,
  CancelPendingBuyOrdersContext,
  CancelPendingBuyOrdersResult,
} from '../../src/core/doomsdayProtection/types.js';
import type { DailyLossTracker, UnrealizedLossMonitor } from '../../src/types/risk.js';
import { createMonitorConfig } from '../../mock/factories/configFactory.js';
import type {
  GetRemainingMsParams,
  LiquidationCooldownTracker,
  RecordCooldownParams,
  ClearMidnightEligibleParams,
  RecordLiquidationTriggerParams,
  RecordLiquidationTriggerResult,
  RestoreTriggerCountParams,
} from '../../src/services/liquidationCooldown/types.js';
import type {
  AutoSymbolManagerPort,
  DelayedSignalVerifierPort,
} from '../../src/types/monitorContextPorts.js';
import type { ProtectiveLiquidationEpisodeTracker } from '../../src/core/trader/protectiveLiquidationEpisodeTracker/types.js';
import { toMockDecimal } from '../../mock/longbridge/decimal.js';
import { createQuoteContextMock } from '../../mock/longbridge/quoteContextMock.js';
import { createTradeContextMock } from '../../mock/longbridge/tradeContextMock.js';

/**
 * 构建测试用 K 线缓存快照。
 *
 * 当测试替身已经持有 candle fixtures 时，直接暴露本地缓存快照，便于
 * processMonitor / quoteClient 类测试沿用真实语义；没有缓存时返回 null。
 *
 * @param symbol 标的代码
 * @param period K 线周期
 * @param candles 本地缓存的 K 线序列
 * @param version 当前缓存版本
 * @returns 本地 K 线缓存快照；无有效缓存时返回 null
 */
function createCandlestickCacheSnapshot(
  symbol: string,
  period: Period,
  candles: ReadonlyArray<CandleData>,
  version: number,
): CandlestickCacheSnapshot | null {
  if (candles.length === 0) {
    return null;
  }

  const latest = candles.at(-1);
  const lastBarTimestamp =
    latest && typeof latest.timestamp === 'number' && Number.isFinite(latest.timestamp)
      ? latest.timestamp
      : null;

  return {
    symbol,
    period,
    version,
    candles,
    lastBarTimestamp,
    lastBarConfirmed: false,
    initialized: true,
  };
}

/**
 * 将测试中的 Candlestick / CandleData 统一收敛为本地缓存使用的 CandleData。
 *
 * @param candles 来自 SDK seed 或测试 fixture 的 K 线数组
 * @returns 可供本地快照与指标计算消费的 CandleData 数组
 */
function normalizeCandlestickData(
  candles: ReadonlyArray<Candlestick | CandleData>,
): ReadonlyArray<CandleData> {
  return candles.map((candle) => {
    const normalized: CandleData = {
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    };

    if (typeof candle.timestamp === 'number') {
      return {
        ...normalized,
        timestamp: candle.timestamp,
      };
    }

    return normalized;
  });
}

/**
 * 创建 SDK Config 测试替身。
 *
 * Longbridge Config 为原生绑定对象，单测只需满足依赖注入边界，不需要真实认证能力。
 */
export function createSdkConfigDouble(): Config {
  return {} as unknown as Config;
}

/**
 * 创建 PositionCache 测试替身。
 *
 * 用于在测试中可控地读写持仓快照，避免依赖真实缓存实现。
 */
export function createPositionCacheDouble(initial: ReadonlyArray<Position> = []): PositionCache {
  const map = new Map<string, Position>();
  for (const position of initial) {
    map.set(position.symbol, position);
  }

  return {
    update(positions: ReadonlyArray<Position>): void {
      map.clear();
      for (const position of positions) {
        map.set(position.symbol, position);
      }
    },
    get(symbol: string): Position | null {
      return map.get(symbol) ?? null;
    },
  };
}

/**
 * 创建 OrderRecorder 测试替身。
 *
 * 默认提供空实现，并允许按用例覆盖关键行为。
 */
export function createOrderRecorderDouble(overrides: Partial<OrderRecorder> = {}): OrderRecorder {
  const base: OrderRecorder = {
    recordLocalBuy: () => {},
    recordLocalSell: () => {},
    clearBuyOrders: () => {},
    getLatestBuyOrderPrice: () => null,
    getLatestSellRecord: () => null,
    getSellRecordByOrderId: () => null,
    fetchAllOrdersFromAPI: async () => [],
    refreshOrdersFromAllOrdersForLong: async () => [],
    refreshOrdersFromAllOrdersForShort: async () => [],
    clearOrdersCacheForSymbol: () => {},
    getBuyOrdersForSymbol: () => [],
    submitSellOrder: () => {},
    updatePendingSell: () => null,
    markSellFilled: () => null,
    markSellPartialFilled: () => null,
    markSellCancelled: () => null,
    getPendingSellSnapshot: () => [],
    allocateRelatedBuyOrderIdsForRecovery: () => [],
    getCostAveragePrice: () => null,
    selectSellableOrders: () => ({
      orders: [],
      totalQuantity: 0,
    }),
    resetAll: () => {},
  };

  return {
    ...base,
    ...overrides,
  };
}

/**
 * 创建 Trader 测试替身。
 *
 * 用于隔离下单与查询副作用，聚焦流程编排断言。
 */
export function createTraderDouble(overrides: Partial<Trader> = {}): Trader {
  const baseOrderRecorder = createOrderRecorderDouble();

  const base: Trader = {
    orderRecorder: baseOrderRecorder,
    getAccountSnapshot: async () => null,
    getStockPositions: async () => [],
    getPendingOrders: async (): Promise<PendingOrder[]> => [],
    seedOrderHoldSymbols: () => {},
    getOrderHoldSymbols: () => new Set<string>(),
    cancelOrder: async () => ({
      kind: 'CANCEL_CONFIRMED',
      closedReason: 'CANCELED',
      source: 'API',
      relatedBuyOrderIds: null,
    }),
    monitorAndManageOrders: async () => {},
    getAndClearPendingRefreshSymbols: (): ReadonlyArray<PendingRefreshSymbol> => [],
    hasPendingProtectiveLiquidationOrders: () => false,
    initializeOrderMonitor: async () => {},
    canTradeNow: (): { readonly canTrade: boolean } => ({ canTrade: true }),
    fetchAllOrdersFromAPI: async () => [],
    resetRuntimeState: () => {},
    recoverOrderTrackingFromSnapshot: async () => {},
    executeSignals: async () => ({ submittedCount: 0, submittedOrderIds: [] }),
  };

  return {
    ...base,
    ...overrides,
    orderRecorder: overrides.orderRecorder ?? base.orderRecorder,
  };
}

/**
 * 创建 RiskChecker 测试替身。
 *
 * 默认放行风控，按需覆盖指定风险分支返回值。
 */
export function createRiskCheckerDouble(overrides: Partial<RiskChecker> = {}): RiskChecker {
  const allowedResult: RiskCheckResult = { allowed: true };
  const base: RiskChecker = {
    setWarrantInfoFromCallPrice: (): WarrantRefreshResult => ({ status: 'ok', isWarrant: true }),
    refreshWarrantInfoForSymbol: async (): Promise<WarrantRefreshResult> => ({
      status: 'notWarrant',
      isWarrant: false,
    }),
    checkBeforeOrder: () => allowedResult,
    checkWarrantRisk: () => allowedResult,
    checkWarrantDistanceLiquidation: (): WarrantDistanceLiquidationResult => ({
      shouldLiquidate: false,
    }),
    getWarrantDistanceInfo: (): WarrantDistanceInfo | null => null,
    clearLongWarrantInfo: () => {},
    clearShortWarrantInfo: () => {},
    refreshUnrealizedLossData: async () => null,
    checkUnrealizedLoss: () => ({ shouldLiquidate: false }),
    getUnrealizedLossMetrics: () => null,
    clearUnrealizedLossData: () => {},
  };

  return {
    ...base,
    ...overrides,
  };
}

/**
 * 创建 DailyLossTracker 测试替身。
 *
 * 默认提供无副作用实现，适用于 app 组装层与监控上下文测试。
 */
export function createDailyLossTrackerDouble(
  overrides: Partial<DailyLossTracker> = {},
): DailyLossTracker {
  const base: DailyLossTracker = {
    resetAll: () => {},
    recalculateFromAllOrders: () => {},
    recordFilledOrder: () => {},
    getLossOffset: () => 0,
    startNewProtectionEpisode: () => {},
  };

  return {
    ...base,
    ...overrides,
  };
}

/**
 * 创建策略测试替身。
 *
 * 默认不生成任何信号，用于隔离组装层与上下文测试。
 */
export function createStrategyDouble(
  overrides: Partial<TradingSignalStrategy> = {},
): TradingSignalStrategy {
  const base: TradingSignalStrategy = {
    generateSignals: () => ({
      immediateSignals: [],
      delayedSignals: [],
    }),
  };

  return {
    ...base,
    ...overrides,
  };
}

/**
 * 创建浮亏监控器测试替身。
 *
 * 默认无副作用，便于仅验证装配与数据填充。
 */
export function createUnrealizedLossMonitorDouble(
  overrides: Partial<UnrealizedLossMonitor> = {},
): UnrealizedLossMonitor {
  const base: UnrealizedLossMonitor = {
    monitorUnrealizedLoss: async () => {},
  };

  return {
    ...base,
    ...overrides,
  };
}

/**
 * 创建延迟验证器测试替身。
 *
 * 默认提供空实现，供 app 装配与 cleanup 测试复用。
 */
export function createDelayedSignalVerifierDouble(
  overrides: Partial<DelayedSignalVerifierPort> = {},
): DelayedSignalVerifierPort {
  const base: DelayedSignalVerifierPort = {
    addSignal: () => {},
    onVerified: () => {},
    cancelAll: () => 0,
    cancelAllForSymbol: () => {},
    cancelAllForDirection: () => 0,
    getPendingCount: () => 0,
    destroy: () => {},
  };

  return {
    ...base,
    ...overrides,
  };
}

/**
 * 创建自动换标管理器测试替身。
 *
 * 默认不触发寻标和换标，用于上下文与主流程测试。
 */
export function createAutoSymbolManagerDouble(
  overrides: Partial<AutoSymbolManagerPort> = {},
): AutoSymbolManagerPort {
  const base: AutoSymbolManagerPort = {
    maybeSearchOnTick: async () => {},
    maybeSwitchOnInterval: async () => {},
    maybeSwitchOnDistance: async () => {},
    hasPendingSwitch: () => false,
    resetAllState: () => {},
  };

  return {
    ...base,
    ...overrides,
  };
}

/**
 * 将 QuoteContext mock 收口为测试可用的 QuoteContext。
 *
 * Longbridge SDK 的 QuoteContext 类型比当前 mock 暴露的子集更宽；
 * 这里集中收口断言，避免在各测试用例中散落无说明的类型断言。
 *
 * @param quoteContextMock 行情上下文 mock；未传时自动创建
 * @returns 可供依赖注入边界消费的 QuoteContext
 */
export function createQuoteContextDouble(
  quoteContextMock: ReturnType<typeof createQuoteContextMock> = createQuoteContextMock(),
): QuoteContext {
  return quoteContextMock as unknown as QuoteContext;
}

/**
 * 将 TradeContext mock 收口为测试可用的 TradeContext。
 *
 * Longbridge SDK 的 TradeContext 类型同样比测试 mock 暴露的能力更宽；
 * 这里集中收口断言，避免在测试中散落无说明的断言。
 *
 * @param tradeContextMock 交易上下文 mock；未传时自动创建
 * @returns 可供依赖注入边界消费的 TradeContext
 */
export function createTradeContextDouble(
  tradeContextMock: ReturnType<typeof createTradeContextMock> = createTradeContextMock(),
): TradeContext {
  return tradeContextMock as unknown as TradeContext;
}

/**
 * 创建 MarketDataClient 测试替身。
 *
 * 默认返回无副作用实现，并提供可覆盖的 getQuoteContext / getQuotes 等方法。
 */
export function createMarketDataClientDouble(
  overrides: Partial<MarketDataClient> = {},
): MarketDataClient {
  const quoteContext = createQuoteContextDouble();
  const candlestickCache = new Map<string, ReadonlyArray<CandleData>>();
  const candlestickVersions = new Map<string, number>();

  function makeCandlestickKey(symbol: string, period: Period): string {
    return `${symbol}:${period}`;
  }

  function getCandlestickCacheSnapshot(
    symbol: string,
    period: Period,
  ): CandlestickCacheSnapshot | null {
    const key = makeCandlestickKey(symbol, period);
    const candles = candlestickCache.get(key);
    if (!candles) {
      return null;
    }

    return createCandlestickCacheSnapshot(
      symbol,
      period,
      candles,
      candlestickVersions.get(key) ?? 1,
    );
  }

  async function seedCandlestickCacheFromOverride(
    symbol: string,
    period: Period,
    tradeSessions?: Parameters<MarketDataClient['subscribeCandlesticks']>[2],
  ): Promise<ReadonlyArray<Candlestick>> {
    const seedCandles = overrides.subscribeCandlesticks
      ? await overrides.subscribeCandlesticks(symbol, period, tradeSessions)
      : [];
    const normalizedCandles = normalizeCandlestickData(seedCandles);
    const key = makeCandlestickKey(symbol, period);
    candlestickCache.set(key, normalizedCandles);
    candlestickVersions.set(key, (candlestickVersions.get(key) ?? 0) + 1);
    return seedCandles;
  }

  const base: MarketDataClient = {
    getQuoteContext: async () => quoteContext,
    getQuotes: async () => new Map(),
    subscribeSymbols: async () => {},
    unsubscribeSymbols: async () => {},
    subscribeCandlesticks: async (symbol, period, tradeSessions) =>
      seedCandlestickCacheFromOverride(symbol, period, tradeSessions),
    getRealtimeCandlesticks: async (symbol: string, period: Period, count: number) => {
      const key = makeCandlestickKey(symbol, period);
      const candles = candlestickCache.get(key);
      if (!candles || candles.length === 0) {
        return [];
      }

      const startIndex = Math.max(candles.length - count, 0);
      return normalizeCandlestickData(candles.slice(startIndex)) as unknown as Candlestick[];
    },
    getCandlestickSnapshot: (symbol, period) => getCandlestickCacheSnapshot(symbol, period),
    isTradingDay: async () => ({ isTradingDay: true, isHalfDay: false }),
    resetRuntimeSubscriptionsAndCaches: async () => {},
  };

  return {
    getQuoteContext: overrides.getQuoteContext ?? base.getQuoteContext,
    getQuotes: overrides.getQuotes ?? base.getQuotes,
    subscribeSymbols: overrides.subscribeSymbols ?? base.subscribeSymbols,
    unsubscribeSymbols: overrides.unsubscribeSymbols ?? base.unsubscribeSymbols,
    subscribeCandlesticks: async (symbol, period, tradeSessions) =>
      seedCandlestickCacheFromOverride(symbol, period, tradeSessions),
    getRealtimeCandlesticks: overrides.getRealtimeCandlesticks ?? base.getRealtimeCandlesticks,
    getCandlestickSnapshot: overrides.getCandlestickSnapshot ?? base.getCandlestickSnapshot,
    isTradingDay: overrides.isTradingDay ?? base.isTradingDay,
    ...((overrides.getTradingDays ?? base.getTradingDays) === undefined
      ? {}
      : {
          getTradingDays: overrides.getTradingDays ?? base.getTradingDays,
        }),
    resetRuntimeSubscriptionsAndCaches: async () => {
      candlestickCache.clear();
      candlestickVersions.clear();
      if (overrides.resetRuntimeSubscriptionsAndCaches) {
        await overrides.resetRuntimeSubscriptionsAndCaches();
      }
    },
  };
}

/**
 * 创建距回收价信息测试数据。
 *
 * 运行时使用 Decimal 保持判定精度，测试侧允许直接传入 number 以简化用例编写。
 *
 * @param params 牛熊证类型与距回收价百分比
 * @returns 符合 WarrantDistanceInfo 的测试对象
 */
export function createWarrantDistanceInfoDouble(params: {
  readonly warrantType: WarrantDistanceInfo['warrantType'];
  readonly distanceToStrikePercent: number | null;
}): WarrantDistanceInfo {
  return {
    warrantType: params.warrantType,
    distanceToStrikePercent:
      params.distanceToStrikePercent === null
        ? null
        : toMockDecimal(params.distanceToStrikePercent),
  };
}

/**
 * 创建 DoomsdayProtection 测试替身。
 *
 * 默认不触发清算，便于按场景精确注入极端保护行为。
 */
export function createDoomsdayProtectionDouble(
  overrides: Partial<DoomsdayProtection> = {},
): DoomsdayProtection {
  const base: DoomsdayProtection = {
    shouldRejectBuy: () => false,
    executeClearance: async (
      _context: DoomsdayClearanceContext,
    ): Promise<DoomsdayClearanceResult> => ({
      executed: false,
      signalCount: 0,
    }),
    cancelPendingBuyOrders: async (
      _context: CancelPendingBuyOrdersContext,
    ): Promise<CancelPendingBuyOrdersResult> => ({
      executed: false,
      cancelRequestAcceptedCount: 0,
    }),
  };

  return {
    ...base,
    ...overrides,
  };
}

/**
 * 创建 LiquidationCooldownTracker 测试替身。
 *
 * 用于在测试中模拟冷却窗口读写而不依赖真实时间状态。
 */
export function createLiquidationCooldownTrackerDouble(
  overrides: Partial<LiquidationCooldownTracker> = {},
): LiquidationCooldownTracker {
  const base: LiquidationCooldownTracker = {
    recordLiquidationTrigger: (
      _params: RecordLiquidationTriggerParams,
    ): RecordLiquidationTriggerResult => ({
      currentCount: 1,
      cooldownActivated: true,
    }),
    recordCooldown: (_params: RecordCooldownParams): void => {},
    restoreTriggerCount: (_params: RestoreTriggerCountParams): void => {},
    getRemainingMs: (_params: GetRemainingMsParams): number => 0,
    clearMidnightEligible: (_params: ClearMidnightEligibleParams): void => {},
    resetAllTriggerCounts: (): void => {},
  };

  return {
    ...base,
    ...overrides,
  };
}

/**
 * 创建 ProtectiveLiquidationEpisodeTracker 测试替身。
 *
 * 用于在测试中模拟保护性清仓事件进度与完成判定。
 */
export function createProtectiveLiquidationEpisodeTrackerDouble(
  overrides: Partial<ProtectiveLiquidationEpisodeTracker> = {},
): ProtectiveLiquidationEpisodeTracker {
  const base: ProtectiveLiquidationEpisodeTracker = {
    recordProtectiveFillProgress: () => {},
    completeIfEligible: () => null,
    restoreCompletedBoundary: () => {},
    restoreInProgressEpisode: () => {},
    getLatestProtectionBoundaryByDirection: () => new Map<string, number>(),
    getInProgressEpisodes: () => [],
    resetAll: () => {},
  };

  return {
    ...base,
    ...overrides,
  };
}

/**
 * 创建 SymbolRegistry 测试替身。
 *
 * 提供可变席位与版本号，支持换标流程与并发校验测试。
 */
export function createSymbolRegistryDouble(params?: {
  readonly monitorSymbol?: string;
  readonly longSeat?: SeatState;
  readonly shortSeat?: SeatState;
  readonly longVersion?: number;
  readonly shortVersion?: number;
}): SymbolRegistry {
  const monitorSymbol = params?.monitorSymbol ?? 'HSI.HK';
  let longSeat = params?.longSeat ?? {
    symbol: 'BULL.HK',
    status: 'ACTIVE',
    lastSwitchAt: null,
    lastSearchAt: null,
    lastSeatActivatedAt: null,
    searchFailCountToday: 0,
    frozenTradingDayKey: null,
  };
  let shortSeat = params?.shortSeat ?? {
    symbol: 'BEAR.HK',
    status: 'ACTIVE',
    lastSwitchAt: null,
    lastSearchAt: null,
    lastSeatActivatedAt: null,
    searchFailCountToday: 0,
    frozenTradingDayKey: null,
  };
  let longVersion = params?.longVersion ?? 1;
  let shortVersion = params?.shortVersion ?? 1;

  return {
    getSeatState(_monitorSymbol: string, direction: 'LONG' | 'SHORT'): SeatState {
      return direction === 'LONG' ? longSeat : shortSeat;
    },
    getSeatVersion(_monitorSymbol: string, direction: 'LONG' | 'SHORT'): number {
      return direction === 'LONG' ? longVersion : shortVersion;
    },
    resolveSeatBySymbol(symbol: string) {
      if (longSeat.symbol === symbol) {
        return {
          monitorSymbol,
          direction: 'LONG' as const,
          seatState: longSeat,
          seatVersion: longVersion,
        };
      }

      if (shortSeat.symbol === symbol) {
        return {
          monitorSymbol,
          direction: 'SHORT' as const,
          seatState: shortSeat,
          seatVersion: shortVersion,
        };
      }

      return null;
    },
    updateSeatState(
      _monitorSymbol: string,
      direction: 'LONG' | 'SHORT',
      nextState: SeatState,
    ): SeatState {
      const normalizedNextState = {
        symbol: nextState.symbol,
        status: nextState.status,
        lastSwitchAt: nextState.lastSwitchAt ?? null,
        lastSearchAt: nextState.lastSearchAt ?? null,
        lastSeatActivatedAt: nextState.lastSeatActivatedAt ?? null,
        callPrice: nextState.callPrice ?? null,
        searchFailCountToday: nextState.searchFailCountToday,
        frozenTradingDayKey: nextState.frozenTradingDayKey,
      };

      if (direction === 'LONG') {
        longSeat = normalizedNextState;
        return longSeat;
      }

      shortSeat = normalizedNextState;
      return shortSeat;
    },
    bumpSeatVersion(_monitorSymbol: string, direction: 'LONG' | 'SHORT'): number {
      if (direction === 'LONG') {
        longVersion += 1;
        return longVersion;
      }

      shortVersion += 1;
      return shortVersion;
    },
  };
}

/**
 * 构造账户快照测试数据。
 *
 * 使用单币种最小结构覆盖买力与现金相关逻辑。
 */
export function createAccountSnapshotDouble(availableCash: number): AccountSnapshot {
  return {
    currency: 'HKD',
    totalCash: availableCash,
    netAssets: availableCash,
    positionValue: 0,
    cashInfos: [
      {
        currency: 'HKD',
        availableCash,
        withdrawCash: availableCash,
        frozenCash: 0,
        settlingCash: 0,
      },
    ],
    buyPower: availableCash,
  };
}

/**
 * 构造持仓测试数据。
 *
 * 统一最小字段，便于验证仓位数量与可卖数量逻辑。
 */
export function createPositionDouble(params: {
  readonly symbol: string;
  readonly quantity: number;
  readonly availableQuantity: number;
}): Position {
  return {
    accountChannel: 'lb_papertrading',
    symbol: params.symbol,
    symbolName: params.symbol,
    quantity: params.quantity,
    availableQuantity: params.availableQuantity,
    currency: 'HKD',
    costPrice: 1,
    market: 'HK',
  };
}

/**
 * 构造行情快照测试数据。
 *
 * 默认前收与现价一致，减少无关价格波动影响。
 */
export function createQuoteDouble(symbol: string, price: number, lotSize: number = 100): Quote {
  return {
    symbol,
    name: symbol,
    price,
    prevClose: price,
    timestamp: Date.now(),
    lotSize,
  };
}

/**
 * 构造监控配置测试数据。
 *
 * 委托 mock/factories/configFactory.createMonitorConfig，测试需默认值时传空 overrides，需覆盖时传入部分字段。
 */
export function createMonitorConfigDouble(overrides: Partial<MonitorConfig> = {}): MonitorConfig {
  return createMonitorConfig(overrides);
}

/**
 * 构造指标画像测试数据。
 *
 * 默认覆盖常见指标集合，支持按用例覆盖族开关、周期、动作指标、验证指标和展示计划。
 */
export function createIndicatorUsageProfileDouble(overrides?: {
  readonly requiredFamilies?: Partial<IndicatorUsageProfile['requiredFamilies']>;
  readonly requiredPeriods?: Partial<IndicatorUsageProfile['requiredPeriods']>;
  readonly actionSignalIndicators?: Partial<Record<StrategyAction, ReadonlyArray<SignalIndicator>>>;
  readonly verificationIndicatorsBySide?: Partial<
    IndicatorUsageProfile['verificationIndicatorsBySide']
  >;
  readonly displayPlan?: ReadonlyArray<DisplayIndicatorItem>;
}): IndicatorUsageProfile {
  const requiredFamilies: IndicatorUsageProfile['requiredFamilies'] = {
    mfi: overrides?.requiredFamilies?.mfi ?? true,
    kdj: overrides?.requiredFamilies?.kdj ?? true,
    macd: overrides?.requiredFamilies?.macd ?? true,
    adx: overrides?.requiredFamilies?.adx ?? true,
  };
  const requiredPeriods: IndicatorUsageProfile['requiredPeriods'] = {
    rsi: overrides?.requiredPeriods?.rsi ?? [6],
    ema: overrides?.requiredPeriods?.ema ?? [7],
    psy: overrides?.requiredPeriods?.psy ?? [13],
  };

  const defaultActionIndicators: Record<StrategyAction, ReadonlyArray<SignalIndicator>> = {
    BUYCALL: ['RSI:6', 'MFI', 'K', 'D', 'J'],
    SELLCALL: ['RSI:6', 'MFI', 'K', 'D', 'J'],
    BUYPUT: ['RSI:6', 'MFI', 'K', 'D', 'J'],
    SELLPUT: ['RSI:6', 'MFI', 'K', 'D', 'J'],
  };

  const actionSignalIndicators: Record<StrategyAction, ReadonlyArray<SignalIndicator>> = {
    BUYCALL: overrides?.actionSignalIndicators?.BUYCALL ?? defaultActionIndicators.BUYCALL,
    SELLCALL: overrides?.actionSignalIndicators?.SELLCALL ?? defaultActionIndicators.SELLCALL,
    BUYPUT: overrides?.actionSignalIndicators?.BUYPUT ?? defaultActionIndicators.BUYPUT,
    SELLPUT: overrides?.actionSignalIndicators?.SELLPUT ?? defaultActionIndicators.SELLPUT,
  };

  const verificationIndicatorsBySide: IndicatorUsageProfile['verificationIndicatorsBySide'] = {
    buy: overrides?.verificationIndicatorsBySide?.buy ?? ['K', 'D', 'J'],
    sell: overrides?.verificationIndicatorsBySide?.sell ?? ['K', 'D', 'J'],
  };

  const defaultDisplayPlan: ReadonlyArray<DisplayIndicatorItem> = [
    'price',
    'changePercent',
    ...requiredPeriods.ema.map((period) => `EMA:${period}` as const),
    ...requiredPeriods.rsi.map((period) => `RSI:${period}` as const),
    ...(requiredFamilies.mfi ? (['MFI'] as const) : []),
    ...requiredPeriods.psy.map((period) => `PSY:${period}` as const),
    ...(requiredFamilies.kdj ? (['K', 'D', 'J'] as const) : []),
    ...(requiredFamilies.adx ? (['ADX'] as const) : []),
    ...(requiredFamilies.macd ? (['MACD', 'DIF', 'DEA'] as const) : []),
  ];

  return {
    requiredFamilies,
    requiredPeriods,
    actionSignalIndicators,
    verificationIndicatorsBySide,
    displayPlan: overrides?.displayPlan ?? defaultDisplayPlan,
  };
}

/**
 * 构造单标的监控状态测试数据。
 *
 * 默认只提供最小运行时状态字段，便于组装层与 cleanup 测试复用。
 */
function createMonitorStateDouble(monitorSymbol: string = 'HSI.HK'): MonitorState {
  return {
    monitorSymbol,
    monitorPrice: null,
    longPrice: null,
    shortPrice: null,
    signal: null,
    pendingDelayedSignals: [],
    monitorValues: null,
    lastMonitorSnapshot: null,
    lastCandlestickCacheVersion: null,
    incrementalIndicatorRuntime: null,
  };
}

/**
 * 创建 MonitorContext 测试替身。
 *
 * 默认填充最小完整结构，允许调用方覆盖任意字段以聚焦特定断言。
 */
export function createMonitorContextDouble(
  overrides: Partial<MonitorContext> = {},
): MonitorContext {
  const config = overrides.config ?? createMonitorConfigDouble();
  const symbolRegistry =
    overrides.symbolRegistry ??
    createSymbolRegistryDouble({
      monitorSymbol: config.monitorSymbol,
    });
  const longSeatState =
    overrides.seatState?.long ?? symbolRegistry.getSeatState(config.monitorSymbol, 'LONG');
  const shortSeatState =
    overrides.seatState?.short ?? symbolRegistry.getSeatState(config.monitorSymbol, 'SHORT');

  return {
    config,
    state: overrides.state ?? createMonitorStateDouble(config.monitorSymbol),
    symbolRegistry,
    seatState: overrides.seatState ?? {
      long: longSeatState,
      short: shortSeatState,
    },
    seatVersion: overrides.seatVersion ?? {
      long: symbolRegistry.getSeatVersion(config.monitorSymbol, 'LONG'),
      short: symbolRegistry.getSeatVersion(config.monitorSymbol, 'SHORT'),
    },
    autoSymbolManager: overrides.autoSymbolManager ?? createAutoSymbolManagerDouble(),
    strategy: overrides.strategy ?? createStrategyDouble(),
    orderRecorder: overrides.orderRecorder ?? createOrderRecorderDouble(),
    dailyLossTracker: overrides.dailyLossTracker ?? createDailyLossTrackerDouble(),
    riskChecker: overrides.riskChecker ?? createRiskCheckerDouble(),
    unrealizedLossMonitor: overrides.unrealizedLossMonitor ?? createUnrealizedLossMonitorDouble(),
    delayedSignalVerifier: overrides.delayedSignalVerifier ?? createDelayedSignalVerifierDouble(),
    longSymbolName: overrides.longSymbolName ?? '',
    shortSymbolName: overrides.shortSymbolName ?? '',
    monitorSymbolName: overrides.monitorSymbolName ?? config.monitorSymbol,
    normalizedMonitorSymbol: overrides.normalizedMonitorSymbol ?? config.monitorSymbol,
    indicatorProfile: overrides.indicatorProfile ?? createIndicatorUsageProfileDouble(),
  };
}

/**
 * 构造交易信号测试数据。
 *
 * 默认给定席位版本与触发时间，便于流水线直接消费。
 */
export function createSignalDouble(action: SignalType, symbol: string): Signal {
  return {
    action,
    symbol,
    symbolName: symbol,
    seatVersion: 1,
    triggerTime: new Date(),
  };
}

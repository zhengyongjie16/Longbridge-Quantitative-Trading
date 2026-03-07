/**
 * 测试替身与工厂（testDoubles）
 *
 * 功能：
 * - 提供测试替身与工厂方法，供其他测试模块使用
 */
import type { Position, AccountSnapshot } from '../../src/types/account.js';
import type { MonitorConfig } from '../../src/types/config.js';
import type { Quote } from '../../src/types/quote.js';
import type { Signal, SignalType } from '../../src/types/signal.js';
import type {
  DisplayIndicatorItem,
  IndicatorUsageProfile,
  ProfileIndicator,
  StrategyAction,
} from '../../src/types/state.js';
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
} from '../../src/types/services.js';
import type { SymbolRegistry, SeatState } from '../../src/types/seat.js';
import type { QuoteContext, TradeContext } from 'longport';
import type {
  DoomsdayProtection,
  DoomsdayClearanceContext,
  DoomsdayClearanceResult,
  CancelPendingBuyOrdersContext,
  CancelPendingBuyOrdersResult,
} from '../../src/core/doomsdayProtection/types.js';
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
import { toMockDecimal } from '../../mock/longport/decimal.js';
import { createQuoteContextMock } from '../../mock/longport/quoteContextMock.js';
import { createTradeContextMock } from '../../mock/longport/tradeContextMock.js';

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
    initializeOrderMonitor: async () => {},
    canTradeNow: (): { readonly canTrade: boolean } => ({ canTrade: true }),
    recordBuyAttempt: () => {},
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
 * 将 QuoteContext mock 收口为测试可用的 QuoteContext。
 *
 * LongPort SDK 的 QuoteContext 类型比当前 mock 暴露的子集更宽；
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
 * LongPort SDK 的 TradeContext 类型同样比测试 mock 暴露的能力更宽；
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
  const base: MarketDataClient = {
    getQuoteContext: async () => quoteContext,
    getQuotes: async () => new Map(),
    subscribeSymbols: async () => {},
    unsubscribeSymbols: async () => {},
    subscribeCandlesticks: async () => [],
    getRealtimeCandlesticks: async () => [],
    isTradingDay: async () => ({ isTradingDay: true, isHalfDay: false }),
    resetRuntimeSubscriptionsAndCaches: async () => {},
  };

  return {
    ...base,
    ...overrides,
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
      cancelledCount: 0,
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
    sweepExpired: () => [],
    clearMidnightEligible: (_params: ClearMidnightEligibleParams): void => {},
    resetAllTriggerCounts: (): void => {},
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
  const longSeat = params?.longSeat ?? {
    symbol: 'BULL.HK',
    status: 'READY',
    lastSwitchAt: null,
    lastSearchAt: null,
    lastSeatReadyAt: null,
    searchFailCountToday: 0,
    frozenTradingDayKey: null,
  };
  const shortSeat = params?.shortSeat ?? {
    symbol: 'BEAR.HK',
    status: 'READY',
    lastSwitchAt: null,
    lastSearchAt: null,
    lastSeatReadyAt: null,
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
      if (direction === 'LONG') {
        Object.assign(longSeat, nextState);
        return longSeat;
      }

      Object.assign(shortSeat, nextState);
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
  readonly actionSignalIndicators?: Partial<
    Record<StrategyAction, ReadonlyArray<ProfileIndicator>>
  >;
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

  const defaultActionIndicators: Record<StrategyAction, ReadonlyArray<ProfileIndicator>> = {
    BUYCALL: ['RSI:6', 'MFI', 'K', 'D', 'J'],
    SELLCALL: ['RSI:6', 'MFI', 'K', 'D', 'J'],
    BUYPUT: ['RSI:6', 'MFI', 'K', 'D', 'J'],
    SELLPUT: ['RSI:6', 'MFI', 'K', 'D', 'J'],
  };

  const actionSignalIndicators: Record<StrategyAction, ReadonlyArray<ProfileIndicator>> = {
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

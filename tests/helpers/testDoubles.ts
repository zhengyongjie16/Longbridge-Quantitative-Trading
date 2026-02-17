/**
 * @module tests/helpers/testDoubles.ts
 * @description 测试模块，围绕 testDoubles.ts 场景验证 tests/helpers 相关业务行为与边界条件。
 */
import type { Position, AccountSnapshot } from '../../src/types/account.js';
import type { MonitorConfig, LiquidationCooldownConfig } from '../../src/types/config.js';
import type { Quote } from '../../src/types/quote.js';
import type { Signal, SignalType } from '../../src/types/signal.js';
import type {
  OrderRecorder,
  PendingOrder,
  PendingRefreshSymbol,
  PositionCache,
  RawOrderFromAPI,
  RiskChecker,
  RiskCheckResult,
  Trader,
  WarrantDistanceInfo,
  WarrantDistanceLiquidationResult,
  WarrantRefreshResult,
} from '../../src/types/services.js';
import type { SymbolRegistry, SeatState } from '../../src/types/seat.js';
import type {
  DoomsdayProtection,
  DoomsdayClearanceContext,
  DoomsdayClearanceResult,
  CancelPendingBuyOrdersContext,
  CancelPendingBuyOrdersResult,
} from '../../src/core/doomsdayProtection/types.js';
import type {
  GetRemainingMsParams,
  LiquidationCooldownTracker,
  RecordCooldownParams,
  ClearMidnightEligibleParams,
} from '../../src/services/liquidationCooldown/types.js';

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

export function createOrderRecorderDouble(overrides: Partial<OrderRecorder> = {}): OrderRecorder {
  const base: OrderRecorder = {
    recordLocalBuy: () => {},
    recordLocalSell: () => {},
    clearBuyOrders: () => {},
    getLatestBuyOrderPrice: () => null,
    getLatestSellRecord: () => null,
    fetchAllOrdersFromAPI: async () => [],
    refreshOrdersFromAllOrdersForLong: async () => [],
    refreshOrdersFromAllOrdersForShort: async () => [],
    clearOrdersCacheForSymbol: () => {},
    getBuyOrdersForSymbol: () => [],
    submitSellOrder: () => {},
    markSellFilled: () => null,
    markSellPartialFilled: () => null,
    markSellCancelled: () => null,
    allocateRelatedBuyOrderIdsForRecovery: () => [],
    getCostAveragePrice: () => null,
    getSellableOrders: () => ({
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

export function createTraderDouble(overrides: Partial<Trader> = {}): Trader {
  const baseOrderRecorder = createOrderRecorderDouble();

  const base: Trader = {
    orderRecorder: baseOrderRecorder,
    getAccountSnapshot: async () => null,
    getStockPositions: async () => [],
    getPendingOrders: async (): Promise<PendingOrder[]> => [],
    seedOrderHoldSymbols: () => {},
    getOrderHoldSymbols: () => new Set<string>(),
    cancelOrder: async () => true,
    monitorAndManageOrders: async () => {},
    getAndClearPendingRefreshSymbols: (): ReadonlyArray<PendingRefreshSymbol> => [],
    canTradeNow: (): { readonly canTrade: boolean } => ({ canTrade: true }),
    recordBuyAttempt: () => {},
    fetchAllOrdersFromAPI: async () => [],
    resetRuntimeState: () => {},
    recoverOrderTracking: async () => {},
    executeSignals: async () => ({ submittedCount: 0 }),
  };

  return {
    ...base,
    ...overrides,
    orderRecorder: overrides.orderRecorder ?? base.orderRecorder,
  };
}

export function createRiskCheckerDouble(overrides: Partial<RiskChecker> = {}): RiskChecker {
  const allowedResult: RiskCheckResult = { allowed: true };
  const base: RiskChecker = {
    setWarrantInfoFromCallPrice: (): WarrantRefreshResult => ({ status: 'ok', isWarrant: true }),
    refreshWarrantInfoForSymbol: async (): Promise<WarrantRefreshResult> => ({ status: 'notWarrant', isWarrant: false }),
    checkBeforeOrder: () => allowedResult,
    checkWarrantRisk: () => allowedResult,
    checkWarrantDistanceLiquidation: (): WarrantDistanceLiquidationResult => ({ shouldLiquidate: false }),
    getWarrantDistanceInfo: (): WarrantDistanceInfo | null => null,
    clearLongWarrantInfo: () => {},
    clearShortWarrantInfo: () => {},
    refreshUnrealizedLossData: async () => null,
    checkUnrealizedLoss: () => ({ shouldLiquidate: false }),
    clearUnrealizedLossData: () => {},
  };

  return {
    ...base,
    ...overrides,
  };
}

export function createDoomsdayProtectionDouble(
  overrides: Partial<DoomsdayProtection> = {},
): DoomsdayProtection {
  const base: DoomsdayProtection = {
    shouldRejectBuy: () => false,
    executeClearance: async (_context: DoomsdayClearanceContext): Promise<DoomsdayClearanceResult> => ({
      executed: false,
      signalCount: 0,
    }),
    cancelPendingBuyOrders: async (_context: CancelPendingBuyOrdersContext): Promise<CancelPendingBuyOrdersResult> => ({
      executed: false,
      cancelledCount: 0,
    }),
  };

  return {
    ...base,
    ...overrides,
  };
}

export function createLiquidationCooldownTrackerDouble(
  overrides: Partial<LiquidationCooldownTracker> = {},
): LiquidationCooldownTracker {
  const base: LiquidationCooldownTracker = {
    recordCooldown: (_params: RecordCooldownParams): void => {},
    getRemainingMs: (_params: GetRemainingMsParams): number => 0,
    clearMidnightEligible: (_params: ClearMidnightEligibleParams): void => {},
  };

  return {
    ...base,
    ...overrides,
  };
}

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
    searchFailCountToday: 0,
    frozenTradingDayKey: null,
  };
  const shortSeat = params?.shortSeat ?? {
    symbol: 'BEAR.HK',
    status: 'READY',
    lastSwitchAt: null,
    lastSearchAt: null,
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
    updateSeatState(_monitorSymbol: string, direction: 'LONG' | 'SHORT', nextState: SeatState): SeatState {
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

export function createMonitorConfigDouble(overrides: Partial<MonitorConfig> = {}): MonitorConfig {
  return {
    originalIndex: 1,
    monitorSymbol: 'HSI.HK',
    longSymbol: 'BULL.HK',
    shortSymbol: 'BEAR.HK',
    autoSearchConfig: {
      autoSearchEnabled: false,
      autoSearchMinDistancePctBull: null,
      autoSearchMinDistancePctBear: null,
      autoSearchMinTurnoverPerMinuteBull: null,
      autoSearchMinTurnoverPerMinuteBear: null,
      autoSearchExpiryMinMonths: 3,
      autoSearchOpenDelayMinutes: 5,
      switchDistanceRangeBull: null,
      switchDistanceRangeBear: null,
    },
    orderOwnershipMapping: [],
    targetNotional: 5000,
    maxPositionNotional: 50000,
    maxDailyLoss: 3000,
    maxUnrealizedLossPerSymbol: 2000,
    buyIntervalSeconds: 60,
    liquidationCooldown: null,
    verificationConfig: {
      buy: {
        delaySeconds: 60,
        indicators: ['K'],
      },
      sell: {
        delaySeconds: 60,
        indicators: ['K'],
      },
    },
    signalConfig: {
      buycall: null,
      sellcall: null,
      buyput: null,
      sellput: null,
    },
    smartCloseEnabled: true,
    ...overrides,
  };
}

export function createSignalDouble(action: SignalType, symbol: string): Signal {
  return {
    action,
    symbol,
    symbolName: symbol,
    seatVersion: 1,
    triggerTime: new Date(),
  };
}

export function createCooldownConfigMinutes(minutes: number): LiquidationCooldownConfig {
  return {
    mode: 'minutes',
    minutes,
  };
}

export function createRawOrderDouble(symbol: string): RawOrderFromAPI {
  return {
    orderId: `RAW-${symbol}`,
    symbol,
    stockName: symbol,
    side: 'Buy' as unknown as RawOrderFromAPI['side'],
    status: 'New' as unknown as RawOrderFromAPI['status'],
    orderType: 'ELO' as unknown as RawOrderFromAPI['orderType'],
    price: 1,
    quantity: 100,
    executedPrice: 0,
    executedQuantity: 0,
    submittedAt: new Date(),
    updatedAt: new Date(),
  };
}

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
  OrderRecorder,
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
} from '../../src/services/liquidationCooldown/types.js';

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
    cancelOrder: async () => true,
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
    recordCooldown: (_params: RecordCooldownParams): void => {},
    getRemainingMs: (_params: GetRemainingMsParams): number => 0,
    clearMidnightEligible: (_params: ClearMidnightEligibleParams): void => {},
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

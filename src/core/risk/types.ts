/**
 * 风险控制模块类型定义
 *
 * 定义风险检查相关的接口和类型：
 * - 牛熊证报价和信息类型
 * - 风险检查器配置选项
 * - 各子检查器服务接口
 * - 依赖注入类型
 */

import type {
  Position,
  Signal,
  SignalType,
  MarketDataClient,
  OrderRecorder,
  MonitorConfig,
  OrderRecord,
  RawOrderFromAPI,
  WarrantType,
  RiskCheckResult,
  WarrantDistanceInfo,
  WarrantDistanceLiquidationResult,
  WarrantRefreshResult,
  UnrealizedLossData,
  UnrealizedLossCheckResult,
} from '../../types/index.js';
import type { OrderFilteringEngine, OrderOwnership } from '../orderRecorder/types.js';

/** 牛熊证报价接口（LongPort API 原始数据） */
export type WarrantQuote = {
  readonly symbol?: string;
  readonly category?: number | string;
  readonly call_price?: unknown;
  readonly callPrice?: unknown;
  readonly [key: string]: unknown;
};

/** 牛熊证信息（解析后的结构化数据） */
export type WarrantInfo =
  | { readonly isWarrant: false }
  | {
      readonly isWarrant: true;
      readonly warrantType: WarrantType;
      readonly callPrice: number | null;
      readonly category: number | string;
      readonly symbol: string;
    };

/** 风险检查器配置选项 */
export type RiskCheckerOptions = {
  readonly maxDailyLoss?: number | null;
  readonly maxPositionNotional?: number | null;
  readonly maxUnrealizedLossPerSymbol?: number | null;
};

// ==================== 服务接口定义 ====================

/** 牛熊证风险检查器接口 */
export interface WarrantRiskChecker {
  initialize(
    marketDataClient: MarketDataClient,
    longSymbol: string,
    shortSymbol: string,
    longSymbolName?: string | null,
    shortSymbolName?: string | null,
  ): Promise<void>;
  refreshWarrantInfoForSymbol(
    marketDataClient: MarketDataClient,
    symbol: string,
    isLongSymbol: boolean,
    symbolName?: string | null,
  ): Promise<WarrantRefreshResult>;
  checkRisk(
    symbol: string,
    signalType: SignalType,
    monitorCurrentPrice: number,
    warrantCurrentPrice: number | null,
  ): RiskCheckResult;
  checkWarrantDistanceLiquidation(
    symbol: string,
    isLongSymbol: boolean,
    monitorCurrentPrice: number,
  ): WarrantDistanceLiquidationResult;
  getWarrantDistanceInfo(
    isLongSymbol: boolean,
    seatSymbol: string,
    monitorCurrentPrice: number | null,
  ): WarrantDistanceInfo | null;
  clearWarrantInfo(isLongSymbol: boolean): void;
}

/** 持仓限制检查器接口 */
export interface PositionLimitChecker {
  checkLimit(
    signal: Signal,
    positions: ReadonlyArray<Position> | null,
    orderNotional: number,
    currentPrice: number | null,
  ): RiskCheckResult;
}

/** 浮亏检查器接口 */
export interface UnrealizedLossChecker {
  getUnrealizedLossData(symbol: string): UnrealizedLossData | undefined;
  getAllData(): ReadonlyMap<string, UnrealizedLossData>;
  isEnabled(): boolean;
  refresh(
    orderRecorder: OrderRecorder,
    symbol: string,
    isLongSymbol: boolean,
    quote?: import('../../types/index.js').Quote | null,
    dailyLossOffset?: number,
  ): Promise<{ r1: number; n1: number } | null>;
  check(
    symbol: string,
    currentPrice: number,
    isLongSymbol: boolean,
  ): UnrealizedLossCheckResult;
}

// ==================== 依赖类型定义 ====================

/** 牛熊证风险检查器依赖（当前无外部依赖） */
export type WarrantRiskCheckerDeps = Record<string, never>;

/** 持仓限制检查器依赖 */
export type PositionLimitCheckerDeps = {
  readonly maxPositionNotional: number | null;
};

/** 浮亏检查器依赖 */
export type UnrealizedLossCheckerDeps = {
  readonly maxUnrealizedLossPerSymbol: number | null;
};

/** 风险检查器依赖（门面模式） */
export type RiskCheckerDeps = {
  readonly options?: RiskCheckerOptions;
};

// ==================== 当日亏损追踪 ====================

export type DailyLossOffset = {
  readonly long: number;
  readonly short: number;
};

export type DailyLossOffsetMap = ReadonlyMap<string, DailyLossOffset>;

export type DailyLossCalculatorParams = {
  readonly orders: ReadonlyArray<RawOrderFromAPI>;
  readonly monitors: ReadonlyArray<Pick<MonitorConfig, 'monitorSymbol'>>;
  readonly now: Date;
  readonly filteringEngine: OrderFilteringEngine;
  readonly resolveOrderOwnership: (
    order: RawOrderFromAPI,
    monitors: ReadonlyArray<Pick<MonitorConfig, 'monitorSymbol'>>,
  ) => OrderOwnership | null;
  readonly classifyAndConvertOrders: (
    orders: ReadonlyArray<RawOrderFromAPI>,
  ) => { buyOrders: OrderRecord[]; sellOrders: OrderRecord[] };
  readonly toBeijingTimeIso: (date: Date | null) => string;
};

export type DailyLossState = {
  readonly buyOrders: ReadonlyArray<OrderRecord>;
  readonly sellOrders: ReadonlyArray<OrderRecord>;
  readonly dailyLossOffset: number;
};

export type DailyLossFilledOrderInput = {
  readonly monitorSymbol: string;
  readonly symbol: string;
  readonly isLongSymbol: boolean;
  readonly side: (typeof import('longport').OrderSide)[keyof typeof import('longport').OrderSide];
  readonly executedPrice: number;
  readonly executedQuantity: number;
  readonly executedTimeMs: number;
  readonly orderId?: string | null;
};

export type DailyLossTracker = {
  initializeFromOrders(
    allOrders: ReadonlyArray<RawOrderFromAPI>,
    monitors: ReadonlyArray<Pick<MonitorConfig, 'monitorSymbol'>>,
    now: Date,
  ): void;
  recalculateFromAllOrders(
    allOrders: ReadonlyArray<RawOrderFromAPI>,
    monitors: ReadonlyArray<Pick<MonitorConfig, 'monitorSymbol'>>,
    now: Date,
  ): void;
  recordFilledOrder(input: DailyLossFilledOrderInput): void;
  getLossOffset(monitorSymbol: string, isLongSymbol: boolean): number;
  resetIfNewDay(now: Date): void;
};

export type DailyLossTrackerDeps = {
  readonly filteringEngine: OrderFilteringEngine;
  readonly resolveOrderOwnership: (
    order: RawOrderFromAPI,
    monitors: ReadonlyArray<Pick<MonitorConfig, 'monitorSymbol'>>,
  ) => OrderOwnership | null;
  readonly classifyAndConvertOrders: (
    orders: ReadonlyArray<RawOrderFromAPI>,
  ) => { buyOrders: OrderRecord[]; sellOrders: OrderRecord[] };
  readonly toBeijingTimeIso: (date: Date | null) => string;
};

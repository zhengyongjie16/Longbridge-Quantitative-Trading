/**
 * 风险控制模块类型定义
 */

import type { Position, Signal, AccountSnapshot } from '../../types/index.js';
import type { MarketDataClient } from '../../services/quoteClient/index.js';
import type { OrderRecorder } from '../orderRecorder/index.js';

/**
 * 牛熊证类型
 */
export type WarrantType = 'BULL' | 'BEAR';

/**
 * 牛熊证报价接口（从 LongPort API 返回）
 */
export type WarrantQuote = {
  readonly symbol?: string;
  readonly category?: number | string;
  readonly call_price?: unknown;
  readonly callPrice?: unknown;
  readonly [key: string]: unknown;
};

/**
 * 牛熊证信息接口
 */
export type WarrantInfo = {
  readonly isWarrant: boolean;
  readonly warrantType?: WarrantType;
  readonly callPrice?: number | null;
  readonly category?: number | string;
  readonly symbol?: string;
};

/**
 * 风险检查结果接口
 */
export type RiskCheckResult = {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly warrantInfo?: {
    readonly isWarrant: boolean;
    readonly warrantType: WarrantType;
    readonly distanceToStrikePercent: number;
  };
};

/**
 * 浮亏数据接口
 */
export type UnrealizedLossData = {
  readonly r1: number;
  readonly n1: number;
  readonly lastUpdateTime: number;
};

/**
 * 浮亏检查结果接口
 */
export type UnrealizedLossCheckResult = {
  readonly shouldLiquidate: boolean;
  readonly reason?: string;
  readonly quantity?: number;
};

/**
 * RiskChecker 构造参数接口
 */
export type RiskCheckerOptions = {
  readonly maxDailyLoss?: number | null;
  readonly maxPositionNotional?: number | null;
  readonly maxUnrealizedLossPerSymbol?: number | null;
};

// ==================== 服务接口定义 ====================

/**
 * 牛熊证风险检查器接口
 */
export interface WarrantRiskChecker {
  initialize(
    marketDataClient: MarketDataClient,
    longSymbol: string,
    shortSymbol: string,
  ): Promise<void>;
  checkRisk(
    symbol: string,
    signalType: string,
    monitorCurrentPrice: number,
  ): RiskCheckResult;
}

/**
 * 持仓限制检查器接口
 */
export interface PositionLimitChecker {
  checkLimit(
    signal: Signal,
    positions: ReadonlyArray<Position> | null,
    orderNotional: number,
    currentPrice: number | null,
  ): RiskCheckResult;
}

/**
 * 浮亏检查器接口
 */
export interface UnrealizedLossChecker {
  getUnrealizedLossData(symbol: string): UnrealizedLossData | undefined;
  getAllData(): Map<string, UnrealizedLossData>;
  isEnabled(): boolean;
  refresh(
    orderRecorder: OrderRecorder,
    symbol: string,
    isLongSymbol: boolean,
  ): Promise<{ r1: number; n1: number } | null>;
  check(
    symbol: string,
    currentPrice: number,
    isLongSymbol: boolean,
  ): UnrealizedLossCheckResult;
}

/**
 * 风险检查器接口（门面）
 */
export interface RiskChecker {
  readonly unrealizedLossData: Map<string, UnrealizedLossData>;
  initializeWarrantInfo(
    marketDataClient: MarketDataClient,
    longSymbol: string,
    shortSymbol: string,
  ): Promise<void>;
  checkBeforeOrder(
    account: AccountSnapshot | null,
    positions: ReadonlyArray<Position> | null,
    signal: Signal | null,
    orderNotional: number,
    currentPrice?: number | null,
    longCurrentPrice?: number | null,
    shortCurrentPrice?: number | null,
  ): RiskCheckResult;
  checkWarrantRisk(
    symbol: string,
    signalType: string,
    monitorCurrentPrice: number,
  ): RiskCheckResult;
  refreshUnrealizedLossData(
    orderRecorder: OrderRecorder,
    symbol: string,
    isLongSymbol: boolean,
  ): Promise<{ r1: number; n1: number } | null>;
  checkUnrealizedLoss(
    symbol: string,
    currentPrice: number,
    isLongSymbol: boolean,
  ): UnrealizedLossCheckResult;
}

// ==================== 依赖类型定义 ====================

/**
 * 牛熊证风险检查器依赖类型
 */
export type WarrantRiskCheckerDeps = Record<string, never>;

/**
 * 持仓限制检查器依赖类型
 */
export type PositionLimitCheckerDeps = {
  readonly maxPositionNotional: number | null;
};

/**
 * 浮亏检查器依赖类型
 */
export type UnrealizedLossCheckerDeps = {
  readonly maxUnrealizedLossPerSymbol: number | null;
};

/**
 * 风险检查器依赖类型
 */
export type RiskCheckerDeps = {
  readonly options?: RiskCheckerOptions;
};

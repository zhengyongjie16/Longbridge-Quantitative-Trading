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
  MarketDataClient,
  OrderRecorder,
  WarrantType,
  RiskCheckResult,
  UnrealizedLossData,
  UnrealizedLossCheckResult,
} from '../../types/index.js';

/** 牛熊证报价接口（LongPort API 原始数据） */
export type WarrantQuote = {
  readonly symbol?: string;
  readonly category?: number | string;
  readonly call_price?: unknown;
  readonly callPrice?: unknown;
  readonly [key: string]: unknown;
};

/** 牛熊证信息（解析后的结构化数据） */
export type WarrantInfo = {
  readonly isWarrant: boolean;
  readonly warrantType?: WarrantType;
  readonly callPrice?: number | null;
  readonly category?: number | string;
  readonly symbol?: string;
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
  checkRisk(
    symbol: string,
    signalType: string,
    monitorCurrentPrice: number,
  ): RiskCheckResult;
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
  getAllData(): Map<string, UnrealizedLossData>;
  isEnabled(): boolean;
  refresh(
    orderRecorder: OrderRecorder,
    symbol: string,
    isLongSymbol: boolean,
    quote?: import('../../types/index.js').Quote | null,
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

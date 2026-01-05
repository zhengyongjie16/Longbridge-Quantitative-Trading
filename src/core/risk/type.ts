/**
 * 风险控制模块类型定义
 */

/**
 * 牛熊证类型
 */
export type WarrantType = 'BULL' | 'BEAR';

/**
 * 牛熊证报价接口（从 LongPort API 返回）
 */
export interface WarrantQuote {
  readonly symbol?: string;
  readonly category?: number | string;
  readonly call_price?: unknown;
  readonly callPrice?: unknown;
  [key: string]: unknown;
}

/**
 * 牛熊证信息接口
 */
export interface WarrantInfo {
  readonly isWarrant: boolean;
  readonly warrantType?: WarrantType;
  readonly callPrice?: number | null;
  readonly category?: number | string;
  readonly symbol?: string;
}

/**
 * 风险检查结果接口
 */
export interface RiskCheckResult {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly warrantInfo?: {
    readonly isWarrant: boolean;
    readonly warrantType: WarrantType;
    readonly distanceToStrikePercent: number;
  };
}

/**
 * 浮亏数据接口
 */
export interface UnrealizedLossData {
  readonly r1: number;
  readonly n1: number;
  readonly lastUpdateTime: number;
}

/**
 * 浮亏检查结果接口
 */
export interface UnrealizedLossCheckResult {
  readonly shouldLiquidate: boolean;
  readonly reason?: string;
  readonly quantity?: number;
}

/**
 * RiskChecker 构造参数接口
 */
export interface RiskCheckerOptions {
  readonly maxDailyLoss?: number | null;
  readonly maxPositionNotional?: number | null;
  readonly maxUnrealizedLossPerSymbol?: number | null;
}


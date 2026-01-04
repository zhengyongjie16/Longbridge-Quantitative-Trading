/**
 * 风险控制模块类型定义
 */

/**
 * 牛熊证类型
 */
export type WarrantType = 'BULL' | 'BEAR';

/**
 * 牛熊证信息接口
 */
export interface WarrantInfo {
  isWarrant: boolean;
  warrantType?: WarrantType;
  callPrice?: number | null;
  category?: number | string;
  symbol?: string;
}

/**
 * 风险检查结果接口
 */
export interface RiskCheckResult {
  allowed: boolean;
  reason?: string;
  warrantInfo?: {
    isWarrant: boolean;
    warrantType: WarrantType;
    distanceToStrikePercent: number;
  };
}

/**
 * 浮亏数据接口
 */
export interface UnrealizedLossData {
  r1: number;
  n1: number;
  lastUpdateTime: number;
}

/**
 * 浮亏检查结果接口
 */
export interface UnrealizedLossCheckResult {
  shouldLiquidate: boolean;
  reason?: string;
  quantity?: number;
}

/**
 * RiskChecker 构造参数接口
 */
export interface RiskCheckerOptions {
  maxDailyLoss?: number | null;
  maxPositionNotional?: number | null;
  maxUnrealizedLossPerSymbol?: number | null;
}


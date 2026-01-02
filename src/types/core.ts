/**
 * 核心数据类型定义
 */

import { OrderSide, OrderStatus, OrderType, Market } from 'longport';

// ==================== 信号类型 ====================

export enum SignalType {
  BUYCALL = 'BUYCALL',   // 买入做多
  SELLCALL = 'SELLCALL', // 卖出做多
  BUYPUT = 'BUYPUT',     // 买入做空
  SELLPUT = 'SELLPUT',   // 卖出做空
  HOLD = 'HOLD',         // 持有
}

/**
 * 通用信号接口 - 所有信号类型的基础
 */
export interface Signal {
  symbol: string;
  symbolName?: string | null;
  action: SignalType;
  reason?: string;
  price?: number | null;
  lotSize?: number | null;
  quantity?: number | null;
  signalTriggerTime?: Date | null;
  useMarketOrder?: boolean;
  // 延迟验证字段
  triggerTime?: Date;
  indicators1?: Record<string, number>;
  verificationHistory?: VerificationEntry[];
}

// 信号类型别名（用于类型守卫）
export type BuySignal = Signal & { action: SignalType.BUYCALL | SignalType.BUYPUT };
export type SellSignal = Signal & { action: SignalType.SELLCALL | SignalType.SELLPUT };
export type HoldSignal = Signal & { action: SignalType.HOLD };

export interface VerificationEntry {
  timestamp: Date;
  indicators: Record<string, number>;
}

// ==================== 持仓和账户 ====================

export interface Position {
  accountChannel: string;
  symbol: string;
  symbolName: string;
  quantity: number;
  availableQuantity: number;
  currency: string;
  costPrice: number;
  market: Market | string;
}

export interface AccountSnapshot {
  currency: string;
  totalCash: number;
  netAssets: number;
  positionValue: number;
}

// ==================== 行情和指标 ====================

export interface Quote {
  symbol: string;
  name: string | null;
  price: number;
  prevClose: number;
  timestamp: number;
  lotSize?: number;
  raw?: unknown;
  staticInfo?: unknown;
}

export interface IndicatorSnapshot {
  price: number;
  changePercent: number | null;
  ema: Record<number, number> | null;
  rsi: Record<number, number> | null;
  mfi: number | null;
  kdj: KDJIndicator | null;
  macd: MACDIndicator | null;
}

export interface KDJIndicator {
  k: number;
  d: number;
  j: number;
}

export interface MACDIndicator {
  macd: number;
  dif: number;
  dea: number;
}

// ==================== 订单 ====================

export interface HistoricalOrder {
  symbol: string;
  orderId: string;
  executedPrice: number;
  executedQuantity: number;
  executedTime: Date;
}

export interface PendingOrder {
  orderId: string;
  symbol: string;
  side: OrderSide;
  submittedPrice: number;
  quantity: number;
  executedQuantity: number;
  status: OrderStatus;
  orderType: OrderType;
  _rawOrder?: unknown;
}

// ==================== 风险检查 ====================

export interface RiskCheckResult {
  allowed: boolean;
  reason: string;
  warrantInfo?: WarrantInfo;
}

export interface WarrantInfo {
  isWarrant: boolean;
  warrantType: 'BULL' | 'BEAR' | null;
  strikePrice: number | null;
  distanceToStrikePercent: number | null;
}

// ==================== 信号配置 ====================

export interface Condition {
  indicator: string;
  operator: '<' | '>';
  threshold: number;
}

export interface ConditionGroup {
  conditions: Condition[];
  requiredCount: number | null;
}

export interface SignalConfig {
  conditionGroups: ConditionGroup[];
}

export interface EvalResult {
  triggered: boolean;
  reason: string;
}

// ==================== K线数据 ====================

export interface Candle {
  high: number;
  low: number;
  close: number;
  open: number;
  volume: number;
  turnover: number;
  timestamp: Date;
}

// ==================== 卖出数量计算结果 ====================

export interface SellQuantityResult {
  quantity: number | null;
  shouldHold: boolean;
  reason: string;
}

// ==================== 信号生成结果 ====================

export interface GenerateSignalsResult {
  immediateSignals: Signal[];
  delayedSignals: Signal[];
}

// ==================== 对象池类型 ====================

export interface PoolableSignal {
  symbol: string | null;
  symbolName?: string | null;
  action: SignalType | null;
  reason?: string | null;
  price?: number | null;
  lotSize?: number | null;
  quantity?: number | null;
  triggerTime?: Date | null;
  indicators1?: Record<string, number> | null;
  verificationHistory?: VerificationEntry[] | null;
  signalTriggerTime?: Date | null;
  useMarketOrder?: boolean;
}

export interface PoolableKDJ {
  k: number | null;
  d: number | null;
  j: number | null;
}

export interface PoolableMACD {
  macd: number | null;
  dif: number | null;
  dea: number | null;
}

export interface PoolableMonitorValues {
  price: number | null;
  changePercent: number | null;
  ema: Record<number, number> | null;
  rsi: Record<number, number> | null;
  mfi: number | null;
  kdj: PoolableKDJ | null;
  macd: PoolableMACD | null;
}

export interface PoolablePosition {
  symbol: string | null;
  costPrice: number;
  quantity: number;
  availableQuantity: number;
}

export interface PoolableVerificationEntry {
  timestamp: Date | null;
  indicators: Record<string, number> | null;
}

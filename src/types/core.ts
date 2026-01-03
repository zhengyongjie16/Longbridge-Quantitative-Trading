/**
 * 核心数据类型定义
 */

import { OrderSide, OrderStatus, OrderType, Market } from 'longport';

// ==================== 信号类型 ====================

/**
 * 信号类型 - 使用联合类型代替 enum
 */
export type SignalType =
  | 'BUYCALL'   // 买入做多
  | 'SELLCALL'  // 卖出做多
  | 'BUYPUT'    // 买入做空
  | 'SELLPUT'   // 卖出做空
  | 'HOLD';     // 持有

/**
 * 验证历史条目
 * 注意：此类型不使用 readonly，因为需要在对象池中修改
 */
export type VerificationEntry = {
  timestamp: Date;
  indicators: Record<string, number>;
};

/**
 * 通用信号类型 - 所有信号类型的基础
 * 注意：此类型不使用 readonly，因为需要在运行时修改属性
 */
export type Signal = {
  symbol: string;
  symbolName: string | null;
  action: SignalType;
  reason?: string;
  price?: number | null;
  lotSize?: number | null;
  quantity?: number | null;
  signalTriggerTime?: Date | null;
  useMarketOrder?: boolean;
  // 延迟验证字段
  triggerTime?: Date | null;
  indicators1?: Record<string, number> | null;
  verificationHistory?: VerificationEntry[] | null;
};

// ==================== 持仓和账户 ====================

/**
 * 持仓信息
 * 注意：此类型不使用 readonly，因为需要在运行时修改
 */
export type Position = {
  accountChannel: string;
  symbol: string;
  symbolName: string;
  quantity: number;
  availableQuantity: number;
  currency: string;
  costPrice: number;
  market: Market | string;
};

/**
 * 账户快照
 */
export type AccountSnapshot = {
  readonly currency: string;
  readonly totalCash: number;
  readonly netAssets: number;
  readonly positionValue: number;
};

// ==================== 行情和指标 ====================

/**
 * 行情数据
 */
export type Quote = {
  readonly symbol: string;
  readonly name: string | null;
  readonly price: number;
  readonly prevClose: number;
  readonly timestamp: number;
  readonly lotSize?: number;
  readonly raw?: unknown;
  readonly staticInfo?: unknown;
};

/**
 * KDJ 指标
 */
export type KDJIndicator = {
  readonly k: number;
  readonly d: number;
  readonly j: number;
};

/**
 * MACD 指标
 */
export type MACDIndicator = {
  readonly macd: number;
  readonly dif: number;
  readonly dea: number;
};

/**
 * 指标快照
 */
export type IndicatorSnapshot = {
  readonly price: number;
  readonly changePercent: number | null;
  readonly ema: Readonly<Record<number, number>> | null;
  readonly rsi: Readonly<Record<number, number>> | null;
  readonly mfi: number | null;
  readonly kdj: KDJIndicator | null;
  readonly macd: MACDIndicator | null;
};

// ==================== 订单 ====================

/**
 * 待处理订单
 * 注意：此类型不使用 readonly，因为需要在运行时修改
 */
export type PendingOrder = {
  orderId: string;
  symbol: string;
  side: OrderSide;
  submittedPrice: number;
  quantity: number;
  executedQuantity: number;
  status: OrderStatus;
  orderType: OrderType;
  _rawOrder?: unknown;
};

// ==================== 风险检查 ====================

/**
 * 牛熊证信息
 */
export type WarrantInfo = {
  readonly isWarrant: boolean;
  readonly warrantType: 'BULL' | 'BEAR' | null;
  readonly strikePrice: number | null;
  readonly distanceToStrikePercent: number | null;
};

/**
 * 风险检查结果
 */
export type RiskCheckResult = {
  readonly allowed: boolean;
  readonly reason: string;
  readonly warrantInfo?: WarrantInfo;
};

// ==================== 信号配置 ====================

/**
 * 信号条件
 */
export type Condition = {
  readonly indicator: string;
  readonly operator: '<' | '>';
  readonly threshold: number;
};

/**
 * 条件组
 */
export type ConditionGroup = {
  readonly conditions: ReadonlyArray<Condition>;
  readonly requiredCount: number | null;
};

/**
 * 信号配置
 */
export type SignalConfig = {
  readonly conditionGroups: ReadonlyArray<ConditionGroup>;
};

// ==================== 对象池类型 ====================

/**
 * 对象池 - Signal
 * 注意：对象池类型是可变的，用于对象重用
 * 属性使用可选标记以匹配 Signal 类型
 */
export type PoolableSignal = {
  symbol: string | null;
  symbolName: string | null;
  action: SignalType | null;
  reason?: string | null;
  price?: number | null;
  lotSize?: number | null;
  quantity?: number | null;
  triggerTime?: Date | null;
  indicators1?: Record<string, number> | null;
  verificationHistory?: VerificationEntry[] | null;
  signalTriggerTime?: Date | null;
  useMarketOrder?: boolean | null;
};

/**
 * 对象池 - KDJ
 */
export type PoolableKDJ = {
  k: number | null;
  d: number | null;
  j: number | null;
};

/**
 * 对象池 - MACD
 */
export type PoolableMACD = {
  macd: number | null;
  dif: number | null;
  dea: number | null;
};

/**
 * 对象池 - 监控数值
 */
export type PoolableMonitorValues = {
  price: number | null;
  changePercent: number | null;
  ema: Record<number, number> | null;
  rsi: Record<number, number> | null;
  mfi: number | null;
  kdj: PoolableKDJ | null;
  macd: PoolableMACD | null;
};

/**
 * 对象池 - Position
 */
export type PoolablePosition = {
  symbol: string | null;
  costPrice: number;
  quantity: number;
  availableQuantity: number;
};

/**
 * 对象池 - VerificationEntry
 * 注意：对象池类型是可变的，用于对象重用
 */
export type PoolableVerificationEntry = {
  timestamp: Date | null;
  indicators: Record<string, number> | null;
};



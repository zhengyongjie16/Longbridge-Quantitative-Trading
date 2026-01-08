/**
 * 类型定义统一导出入口
 * 包含被 src下各个模块共用的类型
 */

import { Market } from 'longport';

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
 * 注意：symbol 字段为可选，因为 Quote 类型已包含 symbol
 */
export type IndicatorSnapshot = {
  readonly symbol?: string;
  readonly price: number;
  readonly changePercent: number | null;
  readonly ema: Readonly<Record<number, number>> | null;
  readonly rsi: Readonly<Record<number, number>> | null;
  readonly mfi: number | null;
  readonly kdj: KDJIndicator | null;
  readonly macd: MACDIndicator | null;
};

// ==================== 公共工具类型 ====================

/**
 * 可转换为数字的类型
 */
export type DecimalLikeValue = string | number | null;

/**
 * 交易日信息类型
 */
export type TradingDayInfo = {
  readonly isTradingDay: boolean;
  readonly isHalfDay: boolean;
};

// ==================== 数据接口 ====================

/**
 * K线数据接口 - 支持 longport SDK 的 Decimal 类型
 */
export interface CandleData {
  high?: unknown;
  low?: unknown;
  close?: unknown;
  open?: unknown;
  volume?: unknown;
}

/**
 * 监控值接口
 */
export interface MonitorValues {
  price: number | null;
  changePercent: number | null;
  ema: Record<number, number> | null;
  rsi: Record<number, number> | null;
  mfi: number | null;
  kdj: KDJIndicator | null;
  macd: MACDIndicator | null;
}

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

// ==================== 配置相关类型 ====================

/**
 * 验证配置
 */
/**
 * 单个验证配置
 */
export type SingleVerificationConfig = {
  readonly delaySeconds: number;
  readonly indicators: ReadonlyArray<string> | null;
};

/**
 * 验证配置（区分买入和卖出）
 */
export type VerificationConfig = {
  readonly buy: SingleVerificationConfig;
  readonly sell: SingleVerificationConfig;
};

/**
 * 信号配置集
 */
export type SignalConfigSet = {
  readonly buycall: SignalConfig | null;
  readonly sellcall: SignalConfig | null;
  readonly buyput: SignalConfig | null;
  readonly sellput: SignalConfig | null;
};

/**
 * 交易配置
 */
export type TradingConfig = {
  readonly monitorSymbol: string | null;
  readonly longSymbol: string | null;
  readonly shortSymbol: string | null;
  readonly targetNotional: number | null;
  readonly longLotSize: number | null;
  readonly shortLotSize: number | null;
  readonly maxPositionNotional: number | null;
  readonly maxDailyLoss: number | null;
  readonly maxUnrealizedLossPerSymbol: number | null;
  readonly doomsdayProtection: boolean;
  readonly buyIntervalSeconds: number;
  readonly verificationConfig: VerificationConfig;
  readonly signalConfig: SignalConfigSet;
};

/**
 * 验证所有配置的返回结果接口
 */
export interface ValidateAllConfigResult {
  monitorName: string;
  longName: string;
  shortName: string;
  marketDataClient: MarketDataClient;
}

// ==================== 主入口模块类型 ====================

/**
 * 状态对象接口
 * 被 index.ts、core/marketMonitor、core/signalVerification 等模块共用
 */
export interface LastState {
  longPrice: number | null;
  shortPrice: number | null;
  signal: string | null;
  canTrade: boolean | null;
  isHalfDay: boolean | null;
  pendingDelayedSignals: Signal[];
  monitorValues: {
    price: number | null;
    changePercent: number | null;
    ema: Record<number, number> | null;
    rsi: Record<number, number> | null;
    mfi: number | null;
    kdj: KDJIndicator | null;
    macd: MACDIndicator | null;
  } | null;
  cachedAccount: AccountSnapshot | null;
  cachedPositions: Position[];
  cachedTradingDayInfo: {
    isTradingDay: boolean;
    isHalfDay: boolean;
    checkDate: string;
  } | null;
  lastMonitorSnapshot: IndicatorSnapshot | null;
}

// ==================== 核心服务接口 ====================

/**
 * K线周期字符串类型
 */
export type PeriodString = '1m' | '5m' | '15m' | '1h' | '1d';

/**
 * 交易日查询结果类型
 */
export type TradingDaysResult = {
  readonly tradingDays: ReadonlyArray<string>;
  readonly halfTradingDays: ReadonlyArray<string>;
};

/**
 * 行情数据客户端接口（公共服务接口）
 */
export interface MarketDataClient {
  _getContext(): Promise<import('longport').QuoteContext>;
  getLatestQuote(symbol: string): Promise<Quote | null>;
  getCandlesticks(
    symbol: string,
    period?: PeriodString | import('longport').Period,
    count?: number,
    adjustType?: import('longport').AdjustType,
    tradeSessions?: import('longport').TradeSessions,
  ): Promise<import('longport').Candlestick[]>;
  getTradingDays(startDate: Date, endDate: Date, market?: import('longport').Market): Promise<TradingDaysResult>;
  isTradingDay(date: Date, market?: import('longport').Market): Promise<TradingDayInfo>;
}

/**
 * 待处理订单接口
 * 注意：此类型不使用 readonly，因为需要在运行时修改
 */
export interface PendingOrder {
  orderId: string;
  symbol: string;
  side: (typeof import('longport').OrderSide)[keyof typeof import('longport').OrderSide];
  submittedPrice: number;
  quantity: number;
  executedQuantity: number;
  status: (typeof import('longport').OrderStatus)[keyof typeof import('longport').OrderStatus];
  orderType: unknown;
  _rawOrder?: unknown;
}

/**
 * 订单记录类型
 */
export type OrderRecord = {
  readonly orderId: string;
  readonly symbol: string;
  readonly executedPrice: number;
  readonly executedQuantity: number;
  readonly executedTime: number;
  readonly submittedAt: Date | undefined;
  readonly updatedAt: Date | undefined;
};

/**
 * 获取订单结果类型
 */
export type FetchOrdersResult = {
  readonly success?: boolean;
  readonly buyOrders: ReadonlyArray<OrderRecord>;
  readonly sellOrders: ReadonlyArray<OrderRecord>;
};

/**
 * 交易检查结果类型
 */
export type TradeCheckResult = {
  readonly canTrade: boolean;
  readonly waitSeconds?: number;
  readonly direction?: 'LONG' | 'SHORT';
  readonly reason?: string;
};

/**
 * 订单记录器接口（公共服务接口）
 */
export interface OrderRecorder {
  recordLocalBuy(symbol: string, executedPrice: number, executedQuantity: number, isLongSymbol: boolean): void;
  recordLocalSell(symbol: string, executedPrice: number, executedQuantity: number, isLongSymbol: boolean): void;
  clearBuyOrders(symbol: string, isLongSymbol: boolean): void;
  getLatestBuyOrderPrice(symbol: string, isLongSymbol: boolean): number | null;
  getBuyOrdersBelowPrice(currentPrice: number, direction: 'LONG' | 'SHORT'): OrderRecord[];
  calculateTotalQuantity(orders: OrderRecord[]): number;
  fetchOrdersFromAPI(symbol: string): Promise<FetchOrdersResult>;
  refreshOrders(symbol: string, isLongSymbol: boolean): Promise<OrderRecord[]>;
  hasCacheForSymbols(symbols: string[]): boolean;
  getPendingOrdersFromCache(symbols: string[]): PendingOrder[];
  getLongBuyOrders(): OrderRecord[];
  getShortBuyOrders(): OrderRecord[];
  getBuyOrdersForSymbol(symbol: string, isLongSymbol: boolean): OrderRecord[];
  readonly _longBuyOrders: OrderRecord[];
  readonly _shortBuyOrders: OrderRecord[];
}

/**
 * 交易器接口（公共服务接口）
 */
export interface Trader {
  readonly _ctxPromise: Promise<import('longport').TradeContext>;

  // 账户相关方法
  getAccountSnapshot(): Promise<AccountSnapshot | null>;
  getStockPositions(symbols?: string[] | null): Promise<Position[]>;

  // 订单缓存相关方法
  getPendingOrders(symbols?: string[] | null, forceRefresh?: boolean): Promise<PendingOrder[]>;
  clearPendingOrdersCache(): void;
  hasPendingBuyOrders(symbols: string[], orderRecorder?: OrderRecorder | null): Promise<boolean>;

  // 订单监控相关方法
  enableBuyOrderMonitoring(): void;
  cancelOrder(orderId: string): Promise<boolean>;
  replaceOrderPrice(orderId: string, newPrice: number, quantity?: number | null, cachedOrder?: PendingOrder | null): Promise<void>;
  monitorAndManageOrders(longQuote: Quote | null, shortQuote: Quote | null): Promise<void>;

  // 订单执行相关方法
  _canTradeNow(signalAction: string): TradeCheckResult;
  executeSignals(signals: Signal[]): Promise<void>;
}

/**
 * 牛熊证类型
 */
export type WarrantType = 'BULL' | 'BEAR';

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
 * 风险检查器接口（公共服务接口）
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



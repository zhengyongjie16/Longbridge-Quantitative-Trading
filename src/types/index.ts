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
 * K线数据值类型 - 支持 longport SDK 的 Decimal 类型或原始数值
 * 使用此类型代替 unknown，提供更明确的类型信息
 */
export type CandleValue = number | string | { toString(): string } | null | undefined;

/**
 * K线数据类型 - 支持 longport SDK 的 Decimal 类型
 * 字段使用 CandleValue 类型，兼容 Decimal 对象和原始数值
 *
 * 注意：使用 type 而非 interface，因为这是数据结构而非行为契约
 */
export type CandleData = {
  readonly high?: CandleValue;
  readonly low?: CandleValue;
  readonly close?: CandleValue;
  readonly open?: CandleValue;
  readonly volume?: CandleValue;
};

/**
 * 监控值类型
 *
 * 注意：使用 type 而非 interface，因为这是数据结构而非行为契约
 */
export type MonitorValues = {
  price: number | null;
  changePercent: number | null;
  ema: Record<number, number> | null;
  rsi: Record<number, number> | null;
  mfi: number | null;
  kdj: KDJIndicator | null;
  macd: MACDIndicator | null;
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
 * 单个监控标的的完整配置
 */
export type MonitorConfig = {
  readonly monitorSymbol: string;
  readonly longSymbol: string;
  readonly shortSymbol: string;
  readonly targetNotional: number;
  readonly longLotSize: number | null;
  readonly shortLotSize: number | null;
  readonly maxPositionNotional: number;
  readonly maxDailyLoss: number;
  readonly maxUnrealizedLossPerSymbol: number;
  readonly buyIntervalSeconds: number;
  readonly verificationConfig: VerificationConfig;
  readonly signalConfig: SignalConfigSet;
};

/**
 * 全局配置（非监控标的特定）
 */
export type GlobalConfig = {
  readonly doomsdayProtection: boolean;
  readonly debug: boolean;
  /** 订单监控超时时间（秒），默认 180（3分钟） */
  readonly orderMonitorTimeoutSeconds: number;
  /** 订单监控价格修改最小间隔（秒），默认 5 */
  readonly orderMonitorPriceUpdateInterval: number;
};

/**
 * 多标的交易配置
 */
export type MultiMonitorTradingConfig = {
  readonly monitors: ReadonlyArray<MonitorConfig>;
  readonly global: GlobalConfig;
};

/**
 * 验证所有配置的返回结果类型
 *
 * 注意：使用 type 而非 interface，因为这是数据结构而非行为契约
 */
export type ValidateAllConfigResult = {
  marketDataClient: MarketDataClient;
};

// ==================== 主入口模块类型 ====================

/**
 * 单个监控标的的状态
 *
 * 注意：使用 type 而非 interface，因为这是数据结构而非行为契约
 */
export type MonitorState = {
  monitorSymbol: string;
  longSymbol: string;
  shortSymbol: string;
  longPrice: number | null;
  shortPrice: number | null;
  signal: string | null;
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
  lastMonitorSnapshot: IndicatorSnapshot | null;
};

/**
 * 状态对象类型
 * 被 index.ts、core/marketMonitor、core/signalVerification 等模块共用
 *
 * 注意：使用 type 而非 interface，因为这是数据结构而非行为契约
 */
export type LastState = {
  canTrade: boolean | null;
  isHalfDay: boolean | null;
  cachedAccount: AccountSnapshot | null;
  cachedPositions: Position[];
  /** 持仓缓存，使用 Map 提供 O(1) 查找性能 */
  positionCache: PositionCache;
  cachedTradingDayInfo: {
    isTradingDay: boolean;
    isHalfDay: boolean;
  } | null;
  monitorStates: Map<string, MonitorState>;
};

/**
 * 监控标的上下文类型
 * 包含单个监控标的的所有相关实例和状态
 *
 * 注意：使用 type 而非 interface，因为这主要是数据聚合而非行为契约
 */
export type MonitorContext = {
  readonly config: MonitorConfig;
  readonly state: MonitorState;
  readonly strategy: import('../core/strategy/types.js').HangSengMultiIndicatorStrategy;
  readonly orderRecorder: OrderRecorder;
  readonly signalVerificationManager: import('../core/signalVerification/types.js').SignalVerificationManager;
  readonly riskChecker: RiskChecker;
  readonly unrealizedLossMonitor: import('../core/unrealizedLossMonitor/types.js').UnrealizedLossMonitor;
  // 缓存标的名称（初始化时获取一次，避免每次循环重复获取）
  longSymbolName: string;
  shortSymbolName: string;
  monitorSymbolName: string;
  // 缓存规范化后的标的代码（避免每次循环重复规范化）
  normalizedLongSymbol: string;
  normalizedShortSymbol: string;
  normalizedMonitorSymbol: string;
};

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
  /**
   * 批量获取多个标的的最新行情
   * 使用单次 API 调用获取所有标的行情，减少 API 调用次数
   *
   * @param symbols 标的代码数组
   * @returns 标的代码到行情数据的 Map（使用规范化后的标的代码作为 key）
   */
  getQuotes(symbols: ReadonlyArray<string>): Promise<Map<string, Quote | null>>;
  getCandlesticks(
    symbol: string,
    period?: PeriodString | import('longport').Period,
    count?: number,
    adjustType?: import('longport').AdjustType,
    tradeSessions?: import('longport').TradeSessions,
  ): Promise<import('longport').Candlestick[]>;
  getTradingDays(startDate: Date, endDate: Date, market?: import('longport').Market): Promise<TradingDaysResult>;
  isTradingDay(date: Date, market?: import('longport').Market): Promise<TradingDayInfo>;
  /**
   * 批量缓存静态信息（供配置验证流程使用）
   * 在程序启动时由 validateSymbolsBatch 调用
   *
   * @param symbols 标的代码数组
   */
  cacheStaticInfo(symbols: ReadonlyArray<string>): Promise<void>;
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
  clearBuyOrders(symbol: string, isLongSymbol: boolean, quote?: Quote | null): void;
  getLatestBuyOrderPrice(symbol: string, isLongSymbol: boolean): number | null;
  getBuyOrdersBelowPrice(currentPrice: number, direction: 'LONG' | 'SHORT'): OrderRecord[];
  calculateTotalQuantity(orders: OrderRecord[]): number;
  fetchOrdersFromAPI(symbol: string): Promise<FetchOrdersResult>;
  refreshOrders(symbol: string, isLongSymbol: boolean, quote?: Quote | null): Promise<OrderRecord[]>;
  hasCacheForSymbols(symbols: string[]): boolean;
  getPendingOrdersFromCache(symbols: string[]): PendingOrder[];
  getLongBuyOrders(): OrderRecord[];
  getShortBuyOrders(): OrderRecord[];
  getBuyOrdersForSymbol(symbol: string, isLongSymbol: boolean): OrderRecord[];
}

/**
 * 交易器接口（公共服务接口）
 */
export interface Trader {
  readonly _ctxPromise: Promise<import('longport').TradeContext>;
  /** 订单记录器实例（内部创建，供外部直接使用） */
  readonly _orderRecorder: OrderRecorder;

  // 账户相关方法
  getAccountSnapshot(): Promise<AccountSnapshot | null>;
  getStockPositions(symbols?: string[] | null): Promise<Position[]>;

  // 订单缓存相关方法
  getPendingOrders(symbols?: string[] | null, forceRefresh?: boolean): Promise<PendingOrder[]>;
  clearPendingOrdersCache(): void;
  hasPendingBuyOrders(symbols: string[], orderRecorder?: OrderRecorder | null): Promise<boolean>;

  // 订单监控相关方法
  /**
   * 开始追踪订单
   * @param orderId 订单ID
   * @param symbol 标的代码
   * @param side 订单方向
   * @param price 委托价格
   * @param quantity 委托数量
   * @param isLongSymbol 是否为做多标的
   */
  trackOrder(
    orderId: string,
    symbol: string,
    side: (typeof import('longport').OrderSide)[keyof typeof import('longport').OrderSide],
    price: number,
    quantity: number,
    isLongSymbol: boolean,
  ): void;
  cancelOrder(orderId: string): Promise<boolean>;
  replaceOrderPrice(orderId: string, newPrice: number, quantity?: number | null): Promise<void>;
  monitorAndManageOrders(quotesMap: ReadonlyMap<string, Quote | null>): Promise<void>;

  /**
   * 获取并清空待刷新浮亏数据的标的列表
   * 订单成交后会将标的添加到此列表，主循环中应调用此方法获取并刷新
   *
   * @returns 待刷新的标的列表（调用后列表会被清空）
   */
  getAndClearPendingRefreshSymbols(): ReadonlyArray<{ readonly symbol: string; readonly isLongSymbol: boolean }>;

  // 订单执行相关方法
  _canTradeNow(signalAction: string, monitorConfig?: MonitorConfig | null): TradeCheckResult;
  /**
   * 标记买入意图（预占买入时间槽）
   * 在 signalProcessor 检查通过后立即调用，防止同一批次中的多个信号同时通过频率检查
   * @param signalAction 信号类型（BUYCALL 或 BUYPUT）
   * @param monitorConfig 监控配置
   */
  _markBuyAttempt(signalAction: string, monitorConfig?: MonitorConfig | null): void;
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
 * 持仓缓存接口
 * 使用 Map 提供 O(1) 查找性能
 */
export interface PositionCache {
  /**
   * 更新持仓缓存
   * @param positions 持仓数组
   */
  update(positions: ReadonlyArray<Position>): void;

  /**
   * 获取指定标的的持仓（O(1) 查找）
   * @param symbol 标的代码（已规范化）
   */
  get(symbol: string): Position | null;

  /**
   * 获取缓存版本号（用于检测持仓是否更新）
   */
  getVersion(): number;

  /**
   * 获取所有持仓
   */
  getAll(): Position[];
}

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
    quote?: Quote | null,
  ): Promise<{ r1: number; n1: number } | null>;
  checkUnrealizedLoss(
    symbol: string,
    currentPrice: number,
    isLongSymbol: boolean,
  ): UnrealizedLossCheckResult;
}



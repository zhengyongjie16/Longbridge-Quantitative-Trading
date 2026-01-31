/**
 * @module types
 * @description 公共类型定义模块
 *
 * 本模块定义了整个量化交易系统中跨模块共享的核心类型，包括：
 * - 信号类型：交易信号和验证相关
 * - 持仓和账户：资产状态和持仓信息
 * - 行情和指标：市场数据和技术指标
 * - 配置类型：监控标的和全局配置
 * - 服务接口：核心服务的公共接口定义
 *
 * 设计原则：
 * - 数据结构使用 type，行为契约使用 interface
 * - 不可变数据使用 readonly，对象池类型例外
 * - 公共类型集中定义，避免重复和循环引用
 */

import { Market } from 'longport';
import type { DoomsdayProtection } from '../core/doomsdayProtection/types.js';

// ==================== 信号类型 ====================

/**
 * 信号类型
 * 表示交易操作的方向和动作
 */
export type SignalType =
  | 'BUYCALL'   // 买入做多（认购）
  | 'SELLCALL'  // 卖出做多（平多仓）
  | 'BUYPUT'    // 买入做空（认沽）
  | 'SELLPUT'   // 卖出做空（平空仓）
  | 'HOLD';     // 持有（不操作）

/**
 * 延迟验证历史条目
 * 记录延迟验证过程中每个时间点的指标快照
 *
 * @remarks 此类型不使用 readonly，因为需要在对象池中修改
 */
export type VerificationEntry = {
  /** 验证时间点 */
  timestamp: Date;
  /** 该时间点的指标值映射 */
  indicators: Record<string, number>;
};

/**
 * 交易信号
 * 表示一次交易操作的完整信息
 *
 * @remarks 此类型不使用 readonly，因为需要在对象池中修改
 */
export type Signal = {
  /** 交易标的代码 */
  symbol: string;
  /** 交易标的名称 */
  symbolName: string | null;
  /** 信号动作类型 */
  action: SignalType;
  /** 信号触发原因 */
  reason?: string | null;
  /** 订单类型覆盖（优先级高于全局配置） */
  orderTypeOverride?: OrderTypeConfig | null;
  /** 是否为保护性清仓（触发买入冷却） */
  isProtectiveLiquidation?: boolean | null;
  /** 交易价格 */
  price?: number | null;
  /** 每手股数 */
  lotSize?: number | null;
  /** 交易数量 */
  quantity?: number | null;
  /**
   * 信号触发时间
   * - 立即信号：信号生成时间
   * - 延迟信号：延迟验证的基准时间（T0）
   * - 末日保护信号：信号生成时间
   */
  triggerTime?: Date | null;
  /** 信号对应的席位版本号（换标后用于丢弃旧信号） */
  seatVersion?: number | null;
  /** 延迟验证：T0 时刻的指标快照 */
  indicators1?: Record<string, number> | null;
  /** 延迟验证：历史验证记录 */
  verificationHistory?: VerificationEntry[] | null;
};

/**
 * 订单类型配置
 * - LO: 限价单（Limit Order）
 * - ELO: 增强限价单（Enhanced Limit Order）
 * - MO: 市价单（Market Order）
 */
export type OrderTypeConfig = 'LO' | 'ELO' | 'MO';

// ==================== 持仓和账户 ====================

/**
 * 持仓信息
 * 表示某个标的的持仓状态
 *
 * @remarks 此类型不使用 readonly，因为需要在运行时修改
 */
export type Position = {
  /** 账户渠道 */
  accountChannel: string;
  /** 标的代码 */
  symbol: string;
  /** 标的名称 */
  symbolName: string;
  /** 持仓数量 */
  quantity: number;
  /** 可用数量（可卖出） */
  availableQuantity: number;
  /** 币种 */
  currency: string;
  /** 成本价 */
  costPrice: number;
  /** 市场 */
  market: Market | string;
};

/**
 * 现金详情
 * 对应 LongPort API accountBalance 返回的 cash_infos 数组元素
 */
export type CashInfo = {
  /** 币种（如 HKD、USD） */
  readonly currency: string;
  /** 可用现金 */
  readonly availableCash: number;
  /** 可提现金额 */
  readonly withdrawCash: number;
  /** 冻结资金 */
  readonly frozenCash: number;
  /** 待交收资金 */
  readonly settlingCash: number;
};

/**
 * 账户快照
 * 表示某一时刻的账户资产状态
 */
export type AccountSnapshot = {
  /** 结算币种 */
  readonly currency: string;
  /** 总现金 */
  readonly totalCash: number;
  /** 净资产 */
  readonly netAssets: number;
  /** 持仓市值 */
  readonly positionValue: number;
  /** 各币种现金详情 */
  readonly cashInfos: ReadonlyArray<CashInfo>;
  /** 购买力 */
  readonly buyPower: number;
};

// ==================== 行情和指标 ====================

/**
 * 行情数据
 * 表示标的的实时行情信息
 */
export type Quote = {
  /** 标的代码 */
  readonly symbol: string;
  /** 标的名称 */
  readonly name: string | null;
  /** 当前价格 */
  readonly price: number;
  /** 前收盘价 */
  readonly prevClose: number;
  /** 行情时间戳 */
  readonly timestamp: number;
  /** 每手股数 */
  readonly lotSize?: number;
  /** 原始行情数据 */
  readonly raw?: unknown;
  /** 静态信息（如回收价等） */
  readonly staticInfo?: unknown;
};

/**
 * KDJ 随机指标
 * 用于判断超买超卖状态
 */
export type KDJIndicator = {
  /** K 值（快速随机值） */
  readonly k: number;
  /** D 值（K 的移动平均） */
  readonly d: number;
  /** J 值（3K-2D） */
  readonly j: number;
};

/**
 * MACD 指标
 * 用于判断趋势方向和强度
 */
export type MACDIndicator = {
  /** MACD 柱状图值 */
  readonly macd: number;
  /** DIF 快线（短期EMA - 长期EMA） */
  readonly dif: number;
  /** DEA 慢线（DIF 的移动平均） */
  readonly dea: number;
};

/**
 * 指标快照
 * 包含某一时刻的所有技术指标值
 */
export type IndicatorSnapshot = {
  /** 标的代码（可选，因为 Quote 已包含） */
  readonly symbol?: string;
  /** 当前价格 */
  readonly price: number;
  /** 涨跌幅（百分比） */
  readonly changePercent: number | null;
  /** EMA 指数移动平均（周期 -> 值） */
  readonly ema: Readonly<Record<number, number>> | null;
  /** RSI 相对强弱指标（周期 -> 值） */
  readonly rsi: Readonly<Record<number, number>> | null;
  /** PSY 心理线指标（周期 -> 值） */
  readonly psy: Readonly<Record<number, number>> | null;
  /** MFI 资金流量指标 */
  readonly mfi: number | null;
  /** KDJ 随机指标 */
  readonly kdj: KDJIndicator | null;
  /** MACD 指标 */
  readonly macd: MACDIndicator | null;
};

// ==================== 公共工具类型 ====================

/**
 * 可转换为数字的值类型
 * 兼容 LongPort SDK 的 Decimal 类型
 */
export type DecimalLikeValue = string | number | null;

/**
 * 交易日信息
 * 用于判断当前是否为交易日及是否为半日市
 */
export type TradingDayInfo = {
  /** 是否为交易日 */
  readonly isTradingDay: boolean;
  /** 是否为半日市（如节假日前一天） */
  readonly isHalfDay: boolean;
};

// ==================== 数据接口 ====================

/**
 * K线数据值类型
 * 兼容 LongPort SDK 的 Decimal 类型和原始数值
 */
export type CandleValue = number | string | { toString(): string } | null | undefined;

/**
 * K线数据
 * 表示单根 K 线的 OHLCV 数据
 */
export type CandleData = {
  /** 最高价 */
  readonly high?: CandleValue;
  /** 最低价 */
  readonly low?: CandleValue;
  /** 收盘价 */
  readonly close?: CandleValue;
  /** 开盘价 */
  readonly open?: CandleValue;
  /** 成交量 */
  readonly volume?: CandleValue;
};

/**
 * 监控值
 * 用于市场监控的技术指标集合
 */
export type MonitorValues = {
  /** 当前价格 */
  price: number | null;
  /** 涨跌幅 */
  changePercent: number | null;
  /** EMA 指数移动平均 */
  ema: Record<number, number> | null;
  /** RSI 相对强弱指标 */
  rsi: Record<number, number> | null;
  /** PSY 心理线指标 */
  psy: Record<number, number> | null;
  /** MFI 资金流量指标 */
  mfi: number | null;
  /** KDJ 随机指标 */
  kdj: KDJIndicator | null;
  /** MACD 指标 */
  macd: MACDIndicator | null;
};

// ==================== 信号配置 ====================

/**
 * 信号触发条件
 * 定义单个指标的触发规则
 */
export type Condition = {
  /** 指标名称（如 rsi_14, kdj_k） */
  readonly indicator: string;
  /** 比较运算符 */
  readonly operator: '<' | '>';
  /** 阈值 */
  readonly threshold: number;
};

/**
 * 条件组
 * 包含一组条件和满足数量要求
 */
export type ConditionGroup = {
  /** 条件列表 */
  readonly conditions: ReadonlyArray<Condition>;
  /** 需满足的条件数量（null 表示全部满足） */
  readonly requiredCount: number | null;
};

/**
 * 信号配置
 * 定义触发某种信号所需的条件组合
 */
export type SignalConfig = {
  /** 条件组列表（组间为 AND 关系） */
  readonly conditionGroups: ReadonlyArray<ConditionGroup>;
};

// ==================== 配置相关类型 ====================

/**
 * 单个延迟验证配置
 * 用于配置买入或卖出的延迟验证参数
 */
export type SingleVerificationConfig = {
  /** 延迟验证时间（秒） */
  readonly delaySeconds: number;
  /** 需验证的指标列表（null 表示不验证） */
  readonly indicators: ReadonlyArray<string> | null;
};

/**
 * 延迟验证配置
 * 分别配置买入和卖出的延迟验证
 */
export type VerificationConfig = {
  /** 买入信号验证配置 */
  readonly buy: SingleVerificationConfig;
  /** 卖出信号验证配置 */
  readonly sell: SingleVerificationConfig;
};

/**
 * 数值范围配置
 * 用于解析 min/max 形式的范围参数
 */
export type NumberRange = {
  readonly min: number;
  readonly max: number;
};

/**
 * 自动寻标配置（单监控标的）
 */
export type AutoSearchConfig = {
  /** 自动寻标开关 */
  readonly autoSearchEnabled: boolean;
  /** 牛证最低价格阈值 */
  readonly autoSearchMinPriceBull: number | null;
  /** 熊证最低价格阈值 */
  readonly autoSearchMinPriceBear: number | null;
  /** 牛证分均成交额阈值 */
  readonly autoSearchMinTurnoverPerMinuteBull: number | null;
  /** 熊证分均成交额阈值 */
  readonly autoSearchMinTurnoverPerMinuteBear: number | null;
  /** 到期日最小月份 */
  readonly autoSearchExpiryMinMonths: number;
  /** 开盘延迟分钟数（仅早盘生效） */
  readonly autoSearchOpenDelayMinutes: number;
  /** 牛证距回收价换标阈值范围 */
  readonly switchDistanceRangeBull: NumberRange | null;
  /** 熊证距回收价换标阈值范围 */
  readonly switchDistanceRangeBear: NumberRange | null;
};

/**
 * 信号配置集
 * 包含四种交易信号的配置
 */
export type SignalConfigSet = {
  /** 买入做多配置 */
  readonly buycall: SignalConfig | null;
  /** 卖出做多配置 */
  readonly sellcall: SignalConfig | null;
  /** 买入做空配置 */
  readonly buyput: SignalConfig | null;
  /** 卖出做空配置 */
  readonly sellput: SignalConfig | null;
};

/**
 * 保护性清仓后的买入冷却配置
 */
export type LiquidationCooldownConfig =
  | {
      readonly mode: 'minutes';
      readonly minutes: number;
    }
  | {
      readonly mode: 'half-day';
    }
  | {
      readonly mode: 'one-day';
    };

/**
 * 单个监控标的的完整配置
 * 包含交易标的、风控参数和信号配置
 */
export type MonitorConfig = {
  /** 原始环境变量索引（对应 _1, _2 等后缀） */
  readonly originalIndex: number;
  /** 监控标的代码（如恒指期货） */
  readonly monitorSymbol: string;
  /** 做多标的代码（牛证） */
  readonly longSymbol: string;
  /** 做空标的代码（熊证） */
  readonly shortSymbol: string;
  /** 自动寻标配置 */
  readonly autoSearchConfig: AutoSearchConfig;
  /** 单次目标交易金额 */
  readonly targetNotional: number;
  /** 单标的最大持仓市值 */
  readonly maxPositionNotional: number;
  /** 单日最大亏损 */
  readonly maxDailyLoss: number;
  /** 单标的最大浮亏 */
  readonly maxUnrealizedLossPerSymbol: number;
  /** 买入间隔时间（秒） */
  readonly buyIntervalSeconds: number;
  /** 保护性清仓后买入冷却配置（未配置时为 null） */
  readonly liquidationCooldown: LiquidationCooldownConfig | null;
  /** 延迟验证配置 */
  readonly verificationConfig: VerificationConfig;
  /** 信号配置集 */
  readonly signalConfig: SignalConfigSet;
  /** 智能平仓开关（true 时仅卖出盈利订单） */
  readonly smartCloseEnabled: boolean;
};

/**
 * 买入订单超时配置
 * 控制买入订单未成交时的超时处理
 */
export type BuyOrderTimeoutConfig = {
  /** 是否启用超时检测 */
  readonly enabled: boolean;
  /** 超时时间（秒） */
  readonly timeoutSeconds: number;
};

/**
 * 卖出订单超时配置
 * 控制卖出订单未成交时的超时处理
 */
export type SellOrderTimeoutConfig = {
  /** 是否启用超时检测 */
  readonly enabled: boolean;
  /** 超时时间（秒） */
  readonly timeoutSeconds: number;
};

/**
 * 开盘保护配置
 * 早盘开盘后暂停交易，避免开盘波动
 */
export type OpenProtectionConfig = {
  /** 是否启用开盘保护 */
  readonly enabled: boolean;
  /** 保护时长（分钟） */
  readonly minutes: number | null;
};

/**
 * 全局配置
 * 非监控标的特定的系统级配置
 */
export type GlobalConfig = {
  /** 末日保护开关（收盘前清仓） */
  readonly doomsdayProtection: boolean;
  /** 调试模式 */
  readonly debug: boolean;
  /** 开盘保护配置 */
  readonly openProtection: OpenProtectionConfig;
  /** 订单价格修改最小间隔（秒） */
  readonly orderMonitorPriceUpdateInterval: number;
  /** 正常交易订单类型 */
  readonly tradingOrderType: OrderTypeConfig;
  /** 清仓订单类型 */
  readonly liquidationOrderType: OrderTypeConfig;
  /** 买入订单超时配置 */
  readonly buyOrderTimeout: BuyOrderTimeoutConfig;
  /** 卖出订单超时配置 */
  readonly sellOrderTimeout: SellOrderTimeoutConfig;
};

/**
 * 多标的交易配置
 * 系统完整配置，包含所有监控标的和全局设置
 */
export type MultiMonitorTradingConfig = {
  /** 监控标的配置列表 */
  readonly monitors: ReadonlyArray<MonitorConfig>;
  /** 全局配置 */
  readonly global: GlobalConfig;
};

// ==================== 席位与标的注册表 ====================

/**
 * 席位状态
 */
export type SeatStatus = 'READY' | 'SEARCHING' | 'SWITCHING' | 'EMPTY';

/**
 * 席位状态信息
 */
export type SeatState = {
  /** 当前占用标的 */
  readonly symbol: string | null;
  /** 席位状态 */
  readonly status: SeatStatus;
  /** 上次换标时间戳（毫秒） */
  readonly lastSwitchAt: number | null;
  /** 上次寻标时间戳（毫秒） */
  readonly lastSearchAt: number | null;
};

/**
 * 席位版本号
 */
export type SeatVersion = number;

/**
 * 标的注册表接口
 * 统一维护席位状态与版本号
 */
export interface SymbolRegistry {
  /** 获取席位状态 */
  getSeatState(monitorSymbol: string, direction: 'LONG' | 'SHORT'): SeatState;
  /** 获取席位版本号 */
  getSeatVersion(monitorSymbol: string, direction: 'LONG' | 'SHORT'): SeatVersion;
  /** 根据标的代码解析所属席位 */
  resolveSeatBySymbol(symbol: string): {
    monitorSymbol: string;
    direction: 'LONG' | 'SHORT';
    seatState: SeatState;
    seatVersion: SeatVersion;
  } | null;
  /** 更新席位状态 */
  updateSeatState(
    monitorSymbol: string,
    direction: 'LONG' | 'SHORT',
    nextState: SeatState,
  ): SeatState;
  /** 递增席位版本号 */
  bumpSeatVersion(monitorSymbol: string, direction: 'LONG' | 'SHORT'): SeatVersion;
}

/**
 * 运行模式
 */
export type RunMode = 'prod' | 'dev';

/**
 * 门禁模式
 */
export type GateMode = 'strict' | 'skip';

export type StartupGateMode = GateMode;
export type RuntimeGateMode = GateMode;

/**
 * 启动阶段的席位标的快照条目
 */
export type SeatSymbolSnapshotEntry = {
  readonly monitorSymbol: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly symbol: string;
};

// ==================== 主入口模块类型 ====================

/**
 * 单个监控标的的运行时状态
 * 在主循环中持续更新
 */
export type MonitorState = {
  /** 监控标的代码 */
  readonly monitorSymbol: string;
  /**
   * 运行中持续更新的状态字段（性能考虑保持可变）
   * - monitorPrice/longPrice/shortPrice/signal/pendingDelayedSignals/monitorValues/lastMonitorSnapshot
   */
  /** 监控标的当前价格 */
  monitorPrice: number | null;
  /** 做多标的当前价格 */
  longPrice: number | null;
  /** 做空标的当前价格 */
  shortPrice: number | null;
  /** 当前信号 */
  signal: SignalType | null;
  /** 待处理的延迟验证信号 */
  pendingDelayedSignals: ReadonlyArray<Signal>;
  /** 监控指标值 */
  monitorValues: MonitorValues | null;
  /** 最新指标快照 */
  lastMonitorSnapshot: IndicatorSnapshot | null;
};

/**
 * 系统全局状态
 * 主循环中的共享状态，被多个模块使用
 */
export type LastState = {
  /**
   * 运行中持续更新的状态字段（性能考虑保持可变）
   * - canTrade/isHalfDay/openProtectionActive/cachedAccount/cachedPositions/cachedTradingDayInfo/allTradingSymbols
   */
  /** 当前是否可交易 */
  canTrade: boolean | null;
  /** 是否为半日市 */
  isHalfDay: boolean | null;
  /** 开盘保护是否生效中 */
  openProtectionActive: boolean | null;
  /** 账户快照缓存 */
  cachedAccount: AccountSnapshot | null;
  /** 持仓列表缓存 */
  cachedPositions: ReadonlyArray<Position>;
  /** 持仓缓存（O(1) 查找） */
  readonly positionCache: PositionCache;
  /** 交易日信息缓存 */
  cachedTradingDayInfo: TradingDayInfo | null;
  /** 各监控标的状态（monitorSymbol -> MonitorState） */
  readonly monitorStates: ReadonlyMap<string, MonitorState>;
  /** 所有交易标的集合（静态，初始化时计算） */
  allTradingSymbols: ReadonlySet<string>;
};

/**
 * 监控标的上下文
 * 聚合单个监控标的的配置、状态和服务实例
 */
export type MonitorContext = {
  /** 监控标的配置 */
  readonly config: MonitorConfig;
  /** 运行时状态 */
  readonly state: MonitorState;
  /** 标的注册表 */
  readonly symbolRegistry: SymbolRegistry;
  /**
   * 运行中会更新的席位缓存（保持可变，避免频繁重建上下文）
   */
  /** 席位状态缓存 */
  seatState: {
    readonly long: SeatState;
    readonly short: SeatState;
  };
  /** 席位版本缓存 */
  seatVersion: {
    readonly long: SeatVersion;
    readonly short: SeatVersion;
  };
  /** 自动换标管理器 */
  readonly autoSymbolManager: import('../services/autoSymbolManager/types.js').AutoSymbolManager;
  /** 策略实例 */
  readonly strategy: import('../core/strategy/types.js').HangSengMultiIndicatorStrategy;
  /** 订单记录器 */
  readonly orderRecorder: OrderRecorder;
  /** 风险检查器 */
  readonly riskChecker: RiskChecker;
  /** 浮亏监控器 */
  readonly unrealizedLossMonitor: import('../core/unrealizedLossMonitor/types.js').UnrealizedLossMonitor;
  /** 延迟信号验证器 */
  readonly delayedSignalVerifier: import('../main/asyncProgram/delayedSignalVerifier/types.js').DelayedSignalVerifier;
  /** 做多标的名称缓存 */
  longSymbolName: string;
  /** 做空标的名称缓存 */
  shortSymbolName: string;
  /** 监控标的名称缓存 */
  monitorSymbolName: string;
  /** 已校验的监控标的代码 */
  readonly normalizedMonitorSymbol: string;
  /** RSI 指标周期配置 */
  rsiPeriods: ReadonlyArray<number>;
  /** EMA 指标周期配置 */
  emaPeriods: ReadonlyArray<number>;
  /** PSY 指标周期配置 */
  psyPeriods: ReadonlyArray<number>;
  /** 做多标的行情缓存 */
  longQuote: Quote | null;
  /** 做空标的行情缓存 */
  shortQuote: Quote | null;
  /** 监控标的行情缓存 */
  monitorQuote: Quote | null;
};

// ==================== 核心服务接口 ====================

/**
 * K线周期
 * 支持 1分钟、5分钟、15分钟、1小时、1日
 */
export type PeriodString = '1m' | '5m' | '15m' | '1h' | '1d';

/**
 * 交易日查询结果
 */
export type TradingDaysResult = {
  /** 完整交易日列表 */
  readonly tradingDays: ReadonlyArray<string>;
  /** 半日交易日列表 */
  readonly halfTradingDays: ReadonlyArray<string>;
};

/**
 * 行情数据客户端接口
 * 封装 LongPort 行情 API，提供行情获取和缓存功能
 */
export interface MarketDataClient {
  /** 获取底层 QuoteContext（内部使用） */
  _getContext(): Promise<import('longport').QuoteContext>;

  /**
   * 批量获取多个标的的最新行情
   * @param symbols 标的代码可迭代对象
   * @returns 标的代码到行情数据的 Map
   */
  getQuotes(symbols: Iterable<string>): Promise<Map<string, Quote | null>>;

  /** 动态订阅行情标的 */
  subscribeSymbols(symbols: ReadonlyArray<string>): Promise<void>;

  /** 取消订阅行情标的 */
  unsubscribeSymbols(symbols: ReadonlyArray<string>): Promise<void>;

  /**
   * 获取 K 线数据
   * @param symbol 标的代码
   * @param period K 线周期
   * @param count 获取数量
   */
  getCandlesticks(
    symbol: string,
    period?: PeriodString | import('longport').Period,
    count?: number,
    adjustType?: import('longport').AdjustType,
    tradeSessions?: import('longport').TradeSessions,
  ): Promise<import('longport').Candlestick[]>;

  /** 获取交易日列表 */
  getTradingDays(startDate: Date, endDate: Date, market?: import('longport').Market): Promise<TradingDaysResult>;

  /** 判断指定日期是否为交易日 */
  isTradingDay(date: Date, market?: import('longport').Market): Promise<TradingDayInfo>;

  /**
   * 批量缓存静态信息
   * 启动时调用，缓存标的的回收价等信息
   */
  cacheStaticInfo(symbols: ReadonlyArray<string>): Promise<void>;
}

/**
 * 待处理订单
 * 表示尚未完全成交的订单
 */
export type PendingOrder = {
  /** 订单 ID */
  readonly orderId: string;
  /** 标的代码 */
  readonly symbol: string;
  /** 买卖方向 */
  readonly side: (typeof import('longport').OrderSide)[keyof typeof import('longport').OrderSide];
  /** 委托价格 */
  readonly submittedPrice: number;
  /** 委托数量 */
  readonly quantity: number;
  /** 已成交数量 */
  readonly executedQuantity: number;
  /** 订单状态 */
  readonly status: (typeof import('longport').OrderStatus)[keyof typeof import('longport').OrderStatus];
  /** 订单类型 */
  readonly orderType: RawOrderFromAPI['orderType'];
  /** 原始订单数据 */
  readonly _rawOrder?: unknown;
};

/**
 * API 返回的原始订单类型
 * 用于从 LongPort API 接收订单数据时的类型安全转换
 */
export type RawOrderFromAPI = {
  readonly orderId: string;
  readonly symbol: string;
  readonly stockName: string;
  readonly side: (typeof import('longport').OrderSide)[keyof typeof import('longport').OrderSide];
  readonly status: (typeof import('longport').OrderStatus)[keyof typeof import('longport').OrderStatus];
  readonly orderType: (typeof import('longport').OrderType)[keyof typeof import('longport').OrderType];
  readonly price: DecimalLikeValue;
  readonly quantity: DecimalLikeValue;
  readonly executedPrice: DecimalLikeValue;
  readonly executedQuantity: DecimalLikeValue;
  readonly submittedAt?: Date | null;
  readonly updatedAt?: Date | null;
};

/**
 * 已成交订单记录
 * 用于记录和计算持仓成本
 */
export type OrderRecord = {
  /** 订单 ID */
  readonly orderId: string;
  /** 标的代码 */
  readonly symbol: string;
  /** 成交价格 */
  readonly executedPrice: number;
  /** 成交数量 */
  readonly executedQuantity: number;
  /** 成交时间戳 */
  readonly executedTime: number;
  /** 下单时间 */
  readonly submittedAt: Date | undefined;
  /** 更新时间 */
  readonly updatedAt: Date | undefined;
};

/**
 * 交易检查结果
 * 检查当前是否可以执行交易
 */
export type TradeCheckResult = {
  /** 是否可以交易 */
  readonly canTrade: boolean;
  /** 需等待秒数（频率限制） */
  readonly waitSeconds?: number;
  /** 交易方向 */
  readonly direction?: 'LONG' | 'SHORT';
  /** 不可交易原因 */
  readonly reason?: string;
};

/**
 * API 频率限制器接口
 */
export interface RateLimiter {
  /** 等待限流通过 */
  throttle(): Promise<void>;
}

/**
 * 订单记录器接口
 * 管理买卖订单的本地记录和 API 同步
 */
export interface OrderRecorder {
  /** 记录本地买入订单 */
  recordLocalBuy(
    symbol: string,
    executedPrice: number,
    executedQuantity: number,
    isLongSymbol: boolean,
    executedTimeMs: number,
  ): void;
  /** 记录本地卖出订单 */
  recordLocalSell(
    symbol: string,
    executedPrice: number,
    executedQuantity: number,
    isLongSymbol: boolean,
    executedTimeMs: number,
    orderId?: string | null,
  ): void;
  /** 清空指定标的的买入订单记录 */
  clearBuyOrders(symbol: string, isLongSymbol: boolean, quote?: Quote | null): void;
  /** 获取最新买入订单价格 */
  getLatestBuyOrderPrice(symbol: string, isLongSymbol: boolean): number | null;
  /** 获取最新卖出订单记录 */
  getLatestSellRecord(symbol: string, isLongSymbol: boolean): OrderRecord | null;
  /** 获取低于指定价格的买入订单（用于智能平仓） */
  getBuyOrdersBelowPrice(currentPrice: number, direction: 'LONG' | 'SHORT', symbol: string): OrderRecord[];
  /** 计算订单列表的总数量 */
  calculateTotalQuantity(orders: OrderRecord[]): number;
  /** 从 API 获取全量订单 */
  fetchAllOrdersFromAPI(forceRefresh?: boolean): Promise<ReadonlyArray<RawOrderFromAPI>>;
  /** 使用全量订单刷新指定标的记录 */
  refreshOrdersFromAllOrders(
    symbol: string,
    isLongSymbol: boolean,
    allOrders: ReadonlyArray<RawOrderFromAPI>,
    quote?: Quote | null,
  ): Promise<OrderRecord[]>;
  /** 清理指定标的的 API 订单缓存（不影响本地订单记录） */
  clearOrdersCacheForSymbol(symbol: string): void;
  /** 检查是否有指定标的的缓存 */
  hasCacheForSymbols(symbols: string[]): boolean;
  /** 从缓存获取待处理订单 */
  getPendingOrdersFromCache(symbols: string[]): PendingOrder[];
  /** 获取所有做多买入订单 */
  getLongBuyOrders(): OrderRecord[];
  /** 获取所有做空买入订单 */
  getShortBuyOrders(): OrderRecord[];
  /** 获取指定标的的买入订单 */
  getBuyOrdersForSymbol(symbol: string, isLongSymbol: boolean): OrderRecord[];
}

/**
 * 交易器接口
 * 封装 LongPort 交易 API，提供订单执行和管理功能
 */
export interface Trader {
  /** 底层 TradeContext Promise */
  readonly _ctxPromise: Promise<import('longport').TradeContext>;
  /** 订单记录器实例 */
  readonly _orderRecorder: OrderRecorder;

  // ========== 账户相关 ==========

  /** 获取账户快照 */
  getAccountSnapshot(): Promise<AccountSnapshot | null>;
  /** 获取持仓列表 */
  getStockPositions(symbols?: string[] | null): Promise<Position[]>;

  // ========== 订单缓存 ==========

  /** 获取待处理订单 */
  getPendingOrders(symbols?: string[] | null, forceRefresh?: boolean): Promise<PendingOrder[]>;
  /** 清空待处理订单缓存 */
  clearPendingOrdersCache(): void;
  /** 检查是否有待处理的买入订单 */
  hasPendingBuyOrders(symbols: string[], orderRecorder?: OrderRecorder | null): Promise<boolean>;

  // ========== 订单监控 ==========

  /** 开始追踪订单状态 */
  trackOrder(
    orderId: string,
    symbol: string,
    side: (typeof import('longport').OrderSide)[keyof typeof import('longport').OrderSide],
    price: number,
    quantity: number,
    isLongSymbol: boolean,
    monitorSymbol: string | null,
    isProtectiveLiquidation: boolean,
  ): void;
  /** 撤销订单 */
  cancelOrder(orderId: string): Promise<boolean>;
  /** 修改订单价格 */
  replaceOrderPrice(orderId: string, newPrice: number, quantity?: number | null): Promise<void>;
  /** 监控和管理待处理订单 */
  monitorAndManageOrders(quotesMap: ReadonlyMap<string, Quote | null>): Promise<void>;
  /** 获取并清空待刷新标的列表 */
  getAndClearPendingRefreshSymbols(): ReadonlyArray<PendingRefreshSymbol>;

  // ========== 订单执行 ==========

  /** 检查当前是否可交易 */
  _canTradeNow(signalAction: string, monitorConfig?: MonitorConfig | null): TradeCheckResult;
  /** 标记买入意图（预占时间槽，防止并发） */
  _markBuyAttempt(signalAction: string, monitorConfig?: MonitorConfig | null): void;
  /** 执行交易信号 */
  executeSignals(signals: Signal[]): Promise<void>;
}

/**
 * 风险检查上下文
 * 执行信号处理时的完整上下文信息
 */
export type RiskCheckContext = {
  /** 交易器 */
  readonly trader: Trader;
  /** 风险检查器 */
  readonly riskChecker: RiskChecker;
  /** 订单记录器 */
  readonly orderRecorder: OrderRecorder;
  /** 做多标的行情 */
  readonly longQuote: Quote | null;
  /** 做空标的行情 */
  readonly shortQuote: Quote | null;
  /** 监控标的行情 */
  readonly monitorQuote: Quote | null;
  /** 监控标的指标快照 */
  readonly monitorSnapshot: IndicatorSnapshot | null;
  /** 做多标的代码 */
  readonly longSymbol: string;
  /** 做空标的代码 */
  readonly shortSymbol: string;
  /** 做多标的名称 */
  readonly longSymbolName: string | null;
  /** 做空标的名称 */
  readonly shortSymbolName: string | null;
  /** 账户缓存（仅用于日志） */
  readonly account: AccountSnapshot | null;
  /** 持仓缓存（仅用于日志） */
  readonly positions: ReadonlyArray<Position>;
  /** 全局状态引用 */
  readonly lastState: {
    cachedAccount?: AccountSnapshot | null;
    cachedPositions?: ReadonlyArray<Position>;
    positionCache: PositionCache;
  };
  /** 当前时间 */
  readonly currentTime: Date;
  /** 是否为半日市 */
  readonly isHalfDay: boolean;
  /** 末日保护实例 */
  readonly doomsdayProtection: DoomsdayProtection;
  /** 监控配置 */
  readonly config: MonitorConfig;
};

/**
 * 待刷新数据的标的信息
 * 订单成交后标记需要刷新的数据类型
 */
export type PendingRefreshSymbol = {
  /** 标的代码 */
  readonly symbol: string;
  /** 是否为做多标的 */
  readonly isLongSymbol: boolean;
  /** 是否刷新账户数据 */
  readonly refreshAccount: boolean;
  /** 是否刷新持仓数据 */
  readonly refreshPositions: boolean;
};

/**
 * 牛熊证类型
 * - BULL: 牛证（做多）
 * - BEAR: 熊证（做空）
 */
export type WarrantType = 'BULL' | 'BEAR';

/**
 * 牛熊证距离回收价信息（用于实时显示）
 */
export type WarrantDistanceInfo = {
  /** 牛熊证类型 */
  readonly warrantType: WarrantType;
  /** 距离回收价百分比 */
  readonly distanceToStrikePercent: number | null;
};

/**
 * 牛熊证信息刷新结果
 */
export type WarrantRefreshResult =
  | { readonly status: 'ok'; readonly isWarrant: true }
  | { readonly status: 'notWarrant'; readonly isWarrant: false }
  | { readonly status: 'error'; readonly isWarrant: false; readonly reason: string }
  | { readonly status: 'skipped'; readonly isWarrant: false };

/**
 * 牛熊证距回收价清仓判定结果
 */
export type WarrantDistanceLiquidationResult = {
  /** 是否触发清仓 */
  readonly shouldLiquidate: boolean;
  /** 牛熊证类型 */
  readonly warrantType?: WarrantType;
  /** 距离回收价百分比 */
  readonly distancePercent?: number | null;
  /** 判定原因 */
  readonly reason?: string;
};

/**
 * 风险检查结果
 */
export type RiskCheckResult = {
  /** 是否允许交易 */
  readonly allowed: boolean;
  /** 不允许原因 */
  readonly reason?: string;
  /** 牛熊证风险信息 */
  readonly warrantInfo?: {
    /** 是否为牛熊证 */
    readonly isWarrant: boolean;
    /** 牛熊证类型 */
    readonly warrantType: WarrantType;
    /** 距离回收价百分比 */
    readonly distanceToStrikePercent: number;
  };
};

/**
 * 浮亏数据
 * 用于计算单标的浮动亏损
 */
export type UnrealizedLossData = {
  /** r1: 累计买入金额 */
  readonly r1: number;
  /** n1: 累计买入数量 */
  readonly n1: number;
  /** 最后更新时间戳 */
  readonly lastUpdateTime: number;
};

/**
 * 浮亏检查结果
 */
export type UnrealizedLossCheckResult = {
  /** 是否应该强制平仓 */
  readonly shouldLiquidate: boolean;
  /** 平仓原因 */
  readonly reason?: string;
  /** 平仓数量 */
  readonly quantity?: number;
};

/**
 * 持仓缓存接口
 * 使用 Map 提供 O(1) 查找性能
 */
export interface PositionCache {
  /** 更新持仓缓存 */
  update(positions: ReadonlyArray<Position>): void;
  /** 获取指定标的的持仓 */
  get(symbol: string): Position | null;
  /** 获取缓存版本号（检测更新） */
  getVersion(): number;
  /** 获取所有持仓 */
  getAll(): Position[];
}

/**
 * 风险检查器接口
 * 门面模式，协调牛熊证风险、持仓限制和浮亏检查
 */
export interface RiskChecker {
  /** 浮亏数据缓存（symbol -> UnrealizedLossData） */
  readonly unrealizedLossData: ReadonlyMap<string, UnrealizedLossData>;

  /** 初始化牛熊证信息（回收价等） */
  initializeWarrantInfo(
    marketDataClient: MarketDataClient,
    longSymbol: string,
    shortSymbol: string,
    longSymbolName?: string | null,
    shortSymbolName?: string | null,
  ): Promise<void>;

  /** 刷新单个标的的牛熊证信息 */
  refreshWarrantInfoForSymbol(
    marketDataClient: MarketDataClient,
    symbol: string,
    isLongSymbol: boolean,
    symbolName?: string | null,
  ): Promise<WarrantRefreshResult>;

  /** 订单前风险检查（持仓限制） */
  checkBeforeOrder(
    account: AccountSnapshot | null,
    positions: ReadonlyArray<Position> | null,
    signal: Signal | null,
    orderNotional: number,
    currentPrice?: number | null,
    longCurrentPrice?: number | null,
    shortCurrentPrice?: number | null,
  ): RiskCheckResult;

  /** 牛熊证风险检查（距离回收价 + 当前价阈值） */
  checkWarrantRisk(
    symbol: string,
    signalType: SignalType,
    monitorCurrentPrice: number,
    warrantCurrentPrice: number | null,
  ): RiskCheckResult;

  /** 牛熊证距回收价清仓检查 */
  checkWarrantDistanceLiquidation(
    symbol: string,
    isLongSymbol: boolean,
    monitorCurrentPrice: number,
  ): WarrantDistanceLiquidationResult;

  /** 获取牛熊证距离回收价信息（实时展示用） */
  getWarrantDistanceInfo(
    isLongSymbol: boolean,
    seatSymbol: string,
    monitorCurrentPrice: number | null,
  ): WarrantDistanceInfo | null;
  /** 清空牛熊证信息缓存（换标时调用） */
  clearWarrantInfo(isLongSymbol: boolean): void;

  /** 刷新浮亏数据 */
  refreshUnrealizedLossData(
    orderRecorder: OrderRecorder,
    symbol: string,
    isLongSymbol: boolean,
    quote?: Quote | null,
  ): Promise<{ r1: number; n1: number } | null>;

  /** 浮亏检查（是否触发强平） */
  checkUnrealizedLoss(
    symbol: string,
    currentPrice: number,
    isLongSymbol: boolean,
  ): UnrealizedLossCheckResult;
}



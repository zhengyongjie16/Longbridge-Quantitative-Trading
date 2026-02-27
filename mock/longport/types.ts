import type {
  AccountBalance,
  Candlestick,
  Decimal,
  Execution,
  GetHistoryOrdersOptions,
  GetTodayExecutionsOptions,
  GetTodayOrdersOptions,
  Market,
  MarketTradingDays,
  Order,
  Period,
  PushCandlestickEvent,
  PushOrderChanged,
  PushQuoteEvent,
  ReplaceOrderOptions,
  SortOrderType,
  StockPositionsResponse,
  SubType,
  SubmitOrderOptions,
  SubmitOrderResponse,
  TopicType,
  TradeSessions,
  WarrantInfo,
  WarrantQuote,
  WarrantSortBy,
  WarrantType,
} from 'longport';

/**
 * LongPort mock 可识别的方法名集合。
 * 类型用途：约束调用记录与失败注入中的方法名字段，避免字符串漂移。
 * 数据来源：QuoteContext / TradeContext mock 实现能力定义。
 * 使用范围：mock/longport 模块内部及其测试使用。
 */
export type MockMethodName =
  | 'quote'
  | 'staticInfo'
  | 'subscribe'
  | 'unsubscribe'
  | 'subscribeCandlesticks'
  | 'unsubscribeCandlesticks'
  | 'realtimeCandlesticks'
  | 'tradingDays'
  | 'warrantQuote'
  | 'warrantList'
  | 'submitOrder'
  | 'cancelOrder'
  | 'replaceOrder'
  | 'todayOrders'
  | 'historyOrders'
  | 'todayExecutions'
  | 'accountBalance'
  | 'stockPositions'
  | 'tradeSubscribe'
  | 'tradeUnsubscribe';

/**
 * LongPort mock 单次调用记录结构。
 * 类型用途：保存方法调用参数、结果和错误，供测试断言调用链路。
 * 数据来源：mock 调用包装器 withMockCall 运行时记录。
 * 使用范围：mock/longport 模块内部及对外 getCalls 返回值。
 */
export type MockCallRecord = {
  readonly method: MockMethodName;
  readonly callIndex: number;
  readonly calledAtMs: number;
  readonly args: ReadonlyArray<unknown>;
  readonly result: unknown;
  readonly error: Error | null;
};

/**
 * LongPort mock 失败注入规则。
 * 类型用途：控制按次数、按谓词或按上限触发失败，验证重试和容错逻辑。
 * 数据来源：测试代码通过 setFailureRule 注入。
 * 使用范围：mock/longport 模块内部及外部测试配置入口。
 */
export type MockFailureRule = {
  readonly failAtCalls?: ReadonlyArray<number>;
  readonly failEveryCalls?: number;
  readonly maxFailures?: number;
  readonly predicate?: (args: ReadonlyArray<unknown>) => boolean;
  readonly errorMessage?: string;
};

/**
 * LongPort mock 失败注入运行时状态。
 * 类型用途：管理方法调用次数、失败次数和规则映射，支撑失败注入判定。
 * 数据来源：createFailureState 在运行期初始化。
 * 使用范围：mock/longport/utils.ts 及上下文 mock 内部使用。
 */
export type MockFailureState = {
  readonly callsByMethod: Map<MockMethodName, number>;
  readonly failedCountByMethod: Map<MockMethodName, number>;
  readonly rules: Map<MockMethodName, MockFailureRule>;
};

/**
 * LongPort mock Decimal 输入联合类型。
 * 类型用途：统一描述 decimal 工具函数可接收的输入值形态。
 * 数据来源：测试数据工厂与 mock 事件构造参数。
 * 使用范围：mock/longport/decimal.ts 使用。
 */
export type MockDecimalInput = string | number | Decimal;

/**
 * Mock 调用日志能力契约。
 * 类型用途：规范 getCalls / clearCalls 两个日志接口的签名。
 * 数据来源：LongPort mock 上下文公共能力抽象。
 * 使用范围：仅本文件内部组合 Quote/Trade 合同接口。
 */
interface MockInvocationLog {
  getCalls: (method?: MockMethodName) => ReadonlyArray<MockCallRecord>;
  clearCalls: () => void;
}

/**
 * Mock 失败注入控制能力契约。
 * 类型用途：规范 setFailureRule / clearFailureRules 两个控制接口签名。
 * 数据来源：LongPort mock 上下文公共能力抽象。
 * 使用范围：仅本文件内部组合 Quote/Trade 合同接口。
 */
interface MockFailureController {
  setFailureRule: (method: MockMethodName, rule: MockFailureRule | null) => void;
  clearFailureRules: () => void;
}

/**
 * QuoteContext mock 合同接口。
 * 类型用途：定义行情 mock 需暴露的查询、订阅、失败注入和调用日志能力。
 * 数据来源：LongPort QuoteContext API 能力映射。
 * 使用范围：mock/longport/quoteContextMock.ts 导出对象契约。
 */
export interface QuoteContextContract extends MockInvocationLog, MockFailureController {
  quote: (symbols: ReadonlyArray<string>) => Promise<ReadonlyArray<unknown>>;
  staticInfo: (symbols: ReadonlyArray<string>) => Promise<ReadonlyArray<unknown>>;
  subscribe: (symbols: ReadonlyArray<string>, subTypes: ReadonlyArray<SubType>) => Promise<void>;
  unsubscribe: (symbols: ReadonlyArray<string>, subTypes: ReadonlyArray<SubType>) => Promise<void>;
  subscribeCandlesticks: (
    symbol: string,
    period: Period,
    tradeSessions?: TradeSessions,
  ) => Promise<ReadonlyArray<Candlestick>>;
  unsubscribeCandlesticks: (symbol: string, period: Period) => Promise<void>;
  realtimeCandlesticks: (
    symbol: string,
    period: Period,
    count: number,
  ) => Promise<ReadonlyArray<Candlestick>>;
  tradingDays: (market: Market, begin: unknown, end: unknown) => Promise<MarketTradingDays>;
  warrantQuote: (symbols: ReadonlyArray<string>) => Promise<ReadonlyArray<WarrantQuote>>;
  warrantList: (
    symbol: string,
    sortBy: WarrantSortBy,
    sortOrder: SortOrderType,
    types: ReadonlyArray<WarrantType>,
  ) => Promise<ReadonlyArray<WarrantInfo>>;
  setOnQuote: (callback: (err: Error | null, event: PushQuoteEvent) => void) => void;
  setOnCandlestick: (callback: (err: Error | null, event: PushCandlestickEvent) => void) => void;
}

/**
 * TradeContext mock 合同接口。
 * 类型用途：定义交易 mock 需暴露的下单、查询、推送订阅、失败注入和调用日志能力。
 * 数据来源：LongPort TradeContext API 能力映射。
 * 使用范围：mock/longport/tradeContextMock.ts 导出对象契约。
 */
export interface TradeContextContract extends MockInvocationLog, MockFailureController {
  submitOrder: (options: SubmitOrderOptions) => Promise<SubmitOrderResponse>;
  cancelOrder: (orderId: string) => Promise<void>;
  replaceOrder: (options: ReplaceOrderOptions) => Promise<void>;
  todayOrders: (options?: GetTodayOrdersOptions) => Promise<ReadonlyArray<Order>>;
  historyOrders: (options?: GetHistoryOrdersOptions) => Promise<ReadonlyArray<Order>>;
  todayExecutions: (options?: GetTodayExecutionsOptions) => Promise<ReadonlyArray<Execution>>;
  accountBalance: (currency?: string) => Promise<ReadonlyArray<AccountBalance>>;
  stockPositions: (symbols?: ReadonlyArray<string>) => Promise<StockPositionsResponse>;
  setOnOrderChanged: (callback: (err: Error | null, event: PushOrderChanged) => void) => void;
  subscribe: (topics: ReadonlyArray<TopicType>) => Promise<void>;
  unsubscribe: (topics: ReadonlyArray<TopicType>) => Promise<void>;
}

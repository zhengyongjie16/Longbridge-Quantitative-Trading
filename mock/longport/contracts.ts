/**
 * @module mock/longport/contracts.ts
 * @description LongPort Mock 契约模块，定义行情/交易上下文的调用协议、失败注入规则与调用日志结构。
 */
import type {
  Candlestick,
  Market,
  MarketTradingDays,
  Period,
  PushCandlestickEvent,
  PushOrderChanged,
  PushQuoteEvent,
  SortOrderType,
  SubType,
  TopicType,
  TradeSessions,
  WarrantInfo,
  WarrantQuote,
  WarrantSortBy,
  WarrantType,
  AccountBalance,
  Execution,
  GetHistoryOrdersOptions,
  GetTodayExecutionsOptions,
  GetTodayOrdersOptions,
  Order,
  ReplaceOrderOptions,
  StockPositionsResponse,
  SubmitOrderOptions,
  SubmitOrderResponse} from 'longport';

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

export type MockCallRecord = {
  readonly method: MockMethodName;
  readonly callIndex: number;
  readonly calledAtMs: number;
  readonly args: ReadonlyArray<unknown>;
  readonly result: unknown;
  readonly error: Error | null;
};

export type MockFailureRule = {
  readonly failAtCalls?: ReadonlyArray<number>;
  readonly failEveryCalls?: number;
  readonly maxFailures?: number;
  readonly predicate?: (args: ReadonlyArray<unknown>) => boolean;
  readonly errorMessage?: string;
};

export interface MockInvocationLog {
  getCalls(method?: MockMethodName): ReadonlyArray<MockCallRecord>;
  clearCalls(): void;
}

export interface MockFailureController {
  setFailureRule(method: MockMethodName, rule: MockFailureRule | null): void;
  clearFailureRules(): void;
}

export interface QuoteContextContract extends MockInvocationLog, MockFailureController {
  quote(symbols: ReadonlyArray<string>): Promise<ReadonlyArray<unknown>>;
  staticInfo(symbols: ReadonlyArray<string>): Promise<ReadonlyArray<unknown>>;
  subscribe(symbols: ReadonlyArray<string>, subTypes: ReadonlyArray<SubType>): Promise<void>;
  unsubscribe(symbols: ReadonlyArray<string>, subTypes: ReadonlyArray<SubType>): Promise<void>;
  subscribeCandlesticks(
    symbol: string,
    period: Period,
    tradeSessions?: TradeSessions,
  ): Promise<ReadonlyArray<Candlestick>>;
  unsubscribeCandlesticks(symbol: string, period: Period): Promise<void>;
  realtimeCandlesticks(symbol: string, period: Period, count: number): Promise<ReadonlyArray<Candlestick>>;
  tradingDays(market: Market, begin: unknown, end: unknown): Promise<MarketTradingDays>;
  warrantQuote(symbols: ReadonlyArray<string>): Promise<ReadonlyArray<WarrantQuote>>;
  warrantList(
    symbol: string,
    sortBy: WarrantSortBy,
    sortOrder: SortOrderType,
    types: ReadonlyArray<WarrantType>,
  ): Promise<ReadonlyArray<WarrantInfo>>;
  setOnQuote(callback: (err: Error | null, event: PushQuoteEvent) => void): void;
  setOnCandlestick(callback: (err: Error | null, event: PushCandlestickEvent) => void): void;
}

export interface TradeContextContract extends MockInvocationLog, MockFailureController {
  submitOrder(options: SubmitOrderOptions): Promise<SubmitOrderResponse>;
  cancelOrder(orderId: string): Promise<void>;
  replaceOrder(options: ReplaceOrderOptions): Promise<void>;
  todayOrders(options?: GetTodayOrdersOptions): Promise<ReadonlyArray<Order>>;
  historyOrders(options?: GetHistoryOrdersOptions): Promise<ReadonlyArray<Order>>;
  todayExecutions(options?: GetTodayExecutionsOptions): Promise<ReadonlyArray<Execution>>;
  accountBalance(currency?: string): Promise<ReadonlyArray<AccountBalance>>;
  stockPositions(symbols?: ReadonlyArray<string>): Promise<StockPositionsResponse>;
  setOnOrderChanged(callback: (err: Error | null, event: PushOrderChanged) => void): void;
  subscribe(topics: ReadonlyArray<TopicType>): Promise<void>;
  unsubscribe(topics: ReadonlyArray<TopicType>): Promise<void>;
}

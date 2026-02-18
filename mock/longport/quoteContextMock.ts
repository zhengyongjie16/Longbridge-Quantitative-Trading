/**
 * 行情上下文 Mock
 *
 * 功能：
 * - 模拟 QuoteContext 的订阅、查询、失败注入与事件回放行为
 */
import {
  type Candlestick,
  type Market,
  type MarketTradingDays,
  type Period,
  type PushCandlestickEvent,
  type PushQuoteEvent,
  type SortOrderType,
  type SubType,
  type TradeSessions,
  type WarrantInfo,
  type WarrantQuote,
  type WarrantSortBy,
  WarrantType,
} from 'longport';
import { createLongportEventBus, type EventPublishOptions, type LongportEventBus } from './eventBus.js';
import type {
  MockCallRecord,
  MockFailureRule,
  MockMethodName,
  QuoteContextContract,
} from './contracts.js';

const QUOTE_METHODS: ReadonlySet<MockMethodName> = new Set([
  'quote',
  'staticInfo',
  'subscribe',
  'unsubscribe',
  'subscribeCandlesticks',
  'unsubscribeCandlesticks',
  'realtimeCandlesticks',
  'tradingDays',
  'warrantQuote',
  'warrantList',
]);

type QuoteContextMockOptions = {
  readonly eventBus?: LongportEventBus;
  readonly now?: () => number;
};

type FailureState = {
  readonly callsByMethod: Map<MockMethodName, number>;
  readonly failedCountByMethod: Map<MockMethodName, number>;
  readonly rules: Map<MockMethodName, MockFailureRule>;
};

function isMethodSupported(method: MockMethodName): boolean {
  return QUOTE_METHODS.has(method);
}

function createFailureState(): FailureState {
  return {
    callsByMethod: new Map(),
    failedCountByMethod: new Map(),
    rules: new Map(),
  };
}

function nextCallIndex(state: FailureState, method: MockMethodName): number {
  const next = (state.callsByMethod.get(method) ?? 0) + 1;
  state.callsByMethod.set(method, next);
  return next;
}

function shouldFail(
  state: FailureState,
  method: MockMethodName,
  callIndex: number,
  args: ReadonlyArray<unknown>,
): Error | null {
  const rule = state.rules.get(method);
  if (!rule) {
    return null;
  }

  const byCallList = rule.failAtCalls?.includes(callIndex) ?? false;
  const byEveryCalls =
    typeof rule.failEveryCalls === 'number' &&
    rule.failEveryCalls > 0 &&
    callIndex % rule.failEveryCalls === 0;
  const byPredicate = rule.predicate?.(args) ?? false;
  const shouldMatch = byCallList || byEveryCalls || byPredicate;

  if (!shouldMatch) {
    return null;
  }

  const failedCount = state.failedCountByMethod.get(method) ?? 0;
  const maxFailures = rule.maxFailures ?? Number.POSITIVE_INFINITY;
  if (failedCount >= maxFailures) {
    return null;
  }

  state.failedCountByMethod.set(method, failedCount + 1);
  return new Error(rule.errorMessage ?? `[MockFailure] ${method} call#${callIndex} failed`);
}

function createCandleKey(symbol: string, period: Period): string {
  return `${symbol}:${String(period)}`;
}

function normalizeWarrantType(value: unknown): 'BULL' | 'BEAR' | null {
  if (value === WarrantType.Bull || value === 3 || value === 'Bull' || value === 'BULL') {
    return 'BULL';
  }
  if (value === WarrantType.Bear || value === 4 || value === 'Bear' || value === 'BEAR') {
    return 'BEAR';
  }
  return null;
}

export interface QuoteContextMock extends QuoteContextContract {
  seedQuotes(quotes: ReadonlyArray<{ readonly symbol: string; readonly quote: unknown }>): void;
  seedStaticInfo(staticInfos: ReadonlyArray<{ readonly symbol: string; readonly info: unknown }>): void;
  seedCandlesticks(symbol: string, period: Period, candles: ReadonlyArray<Candlestick>): void;
  seedTradingDays(key: string, value: MarketTradingDays): void;
  seedWarrantQuotes(quotes: ReadonlyArray<WarrantQuote>): void;
  seedWarrantList(symbol: string, list: ReadonlyArray<WarrantInfo>): void;
  emitQuote(event: PushQuoteEvent, options?: EventPublishOptions): void;
  emitCandlestick(event: PushCandlestickEvent, options?: EventPublishOptions): void;
  flushEvents(nowMs?: number): number;
  flushAllEvents(): number;
  getSubscribedSymbols(): ReadonlySet<string>;
  getSubscribedCandlestickKeys(): ReadonlySet<string>;
}

function getTradingDaysKey(market: Market, begin: unknown, end: unknown): string {
  return `${String(market)}:${String(begin)}:${String(end)}`;
}

/**
 * 创建 QuoteContext 的测试替身。
 *
 * 通过内存存储、失败注入和事件总线回放，模拟真实行情上下文在查询、订阅和推送上的行为，
 * 以支撑流程测试与异常恢复测试。
 */
export function createQuoteContextMock(options: QuoteContextMockOptions = {}): QuoteContextMock {
  const now = options.now ?? (() => Date.now());
  const bus = options.eventBus ?? createLongportEventBus(now);

  const failureState = createFailureState();
  const callRecords: MockCallRecord[] = [];

  const quoteBySymbol = new Map<string, unknown>();
  const staticInfoBySymbol = new Map<string, unknown>();
  const candlesticksByKey = new Map<string, ReadonlyArray<Candlestick>>();
  const warrantQuoteBySymbol = new Map<string, WarrantQuote>();
  const warrantListBySymbol = new Map<string, ReadonlyArray<WarrantInfo>>();
  const tradingDaysByKey = new Map<string, MarketTradingDays>();

  const subscribedSymbols = new Set<string>();
  const subscribedByType = new Map<string, Set<SubType>>();
  const subscribedCandlestickKeys = new Set<string>();

  let quoteSubscriptionDisposer: (() => void) | null = null;
  let candlestickSubscriptionDisposer: (() => void) | null = null;

  function recordCall(
    method: MockMethodName,
    callIndex: number,
    args: ReadonlyArray<unknown>,
    result: unknown,
    error: Error | null,
  ): void {
    callRecords.push({
      method,
      callIndex,
      calledAtMs: now(),
      args,
      result,
      error,
    });
  }

  async function withCall<T>(
    method: MockMethodName,
    args: ReadonlyArray<unknown>,
    action: () => Promise<T> | T,
  ): Promise<T> {
    // 所有对外能力统一走这里，确保失败注入与调用日志语义一致。
    const callIndex = nextCallIndex(failureState, method);
    const injectedError = shouldFail(failureState, method, callIndex, args);
    if (injectedError) {
      recordCall(method, callIndex, args, null, injectedError);
      throw injectedError;
    }

    try {
      const result = await action();
      recordCall(method, callIndex, args, result, null);
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      recordCall(method, callIndex, args, null, error);
      throw error;
    }
  }

  function quote(symbols: ReadonlyArray<string>): Promise<ReadonlyArray<unknown>> {
    return withCall('quote', [symbols], () =>
      symbols
        .map((symbol) => quoteBySymbol.get(symbol) ?? null)
        .filter((item) => item !== null),
    );
  }

  function staticInfo(symbols: ReadonlyArray<string>): Promise<ReadonlyArray<unknown>> {
    return withCall('staticInfo', [symbols], () =>
      symbols
        .map((symbol) => staticInfoBySymbol.get(symbol) ?? null)
        .filter((item) => item !== null),
    );
  }

  function subscribe(symbols: ReadonlyArray<string>, subTypes: ReadonlyArray<SubType>): Promise<void> {
    return withCall('subscribe', [symbols, subTypes], () => {
      for (const symbol of symbols) {
        subscribedSymbols.add(symbol);
        const current = subscribedByType.get(symbol) ?? new Set<SubType>();
        for (const subType of subTypes) {
          current.add(subType);
        }
        subscribedByType.set(symbol, current);
      }
    });
  }

  function unsubscribe(symbols: ReadonlyArray<string>, subTypes: ReadonlyArray<SubType>): Promise<void> {
    return withCall('unsubscribe', [symbols, subTypes], () => {
      for (const symbol of symbols) {
        const current = subscribedByType.get(symbol);
        if (!current) {
          continue;
        }

        for (const subType of subTypes) {
          current.delete(subType);
        }

        if (current.size === 0) {
          subscribedByType.delete(symbol);
          subscribedSymbols.delete(symbol);
          quoteBySymbol.delete(symbol);
          staticInfoBySymbol.delete(symbol);
        }
      }
    });
  }

  function subscribeCandlesticks(
    symbol: string,
    period: Period,
    _tradeSessions?: TradeSessions,
  ): Promise<ReadonlyArray<Candlestick>> {
    return withCall('subscribeCandlesticks', [symbol, period], () => {
      const key = createCandleKey(symbol, period);
      subscribedCandlestickKeys.add(key);
      return candlesticksByKey.get(key) ?? [];
    });
  }

  function unsubscribeCandlesticks(symbol: string, period: Period): Promise<void> {
    return withCall('unsubscribeCandlesticks', [symbol, period], () => {
      const key = createCandleKey(symbol, period);
      subscribedCandlestickKeys.delete(key);
      candlesticksByKey.delete(key);
    });
  }

  function realtimeCandlesticks(
    symbol: string,
    period: Period,
    count: number,
  ): Promise<ReadonlyArray<Candlestick>> {
    return withCall('realtimeCandlesticks', [symbol, period, count], () => {
      const key = createCandleKey(symbol, period);
      const data = candlesticksByKey.get(key) ?? [];
      if (count <= 0 || data.length <= count) {
        return data;
      }
      return data.slice(data.length - count);
    });
  }

  function tradingDays(market: Market, begin: unknown, end: unknown): Promise<MarketTradingDays> {
    return withCall('tradingDays', [market, begin, end], () => {
      const key = getTradingDaysKey(market, begin, end);
      const found = tradingDaysByKey.get(key);
      if (found) {
        return found;
      }

      return {
        tradingDays: [],
        halfTradingDays: [],
      } as unknown as MarketTradingDays;
    });
  }

  function warrantQuote(symbols: ReadonlyArray<string>): Promise<ReadonlyArray<WarrantQuote>> {
    return withCall('warrantQuote', [symbols], () =>
      symbols
        .map((symbol) => warrantQuoteBySymbol.get(symbol) ?? null)
        .filter((item): item is WarrantQuote => item !== null),
    );
  }

  function warrantList(
    symbol: string,
    _sortBy: WarrantSortBy,
    _sortOrder: SortOrderType,
    types: ReadonlyArray<WarrantType>,
  ): Promise<ReadonlyArray<WarrantInfo>> {
    return withCall('warrantList', [symbol, types], () => {
      const list = warrantListBySymbol.get(symbol) ?? [];
      if (types.length === 0) {
        return list;
      }
      const typeSet = new Set(
        types
          .map((type) => normalizeWarrantType(type))
          .filter((item): item is 'BULL' | 'BEAR' => item !== null),
      );
      return list.filter((item) => {
        const normalizedType = normalizeWarrantType(item.warrantType);
        if (normalizedType === null) {
          return false;
        }
        return typeSet.has(normalizedType);
      });
    });
  }

  function setOnQuote(callback: (err: Error | null, event: PushQuoteEvent) => void): void {
    quoteSubscriptionDisposer?.();
    quoteSubscriptionDisposer = bus.subscribe('quote', (payload) => {
      callback(null, payload);
    });
  }

  function setOnCandlestick(
    callback: (err: Error | null, event: PushCandlestickEvent) => void,
  ): void {
    candlestickSubscriptionDisposer?.();
    candlestickSubscriptionDisposer = bus.subscribe('candlestick', (payload) => {
      callback(null, payload);
    });
  }

  function setFailureRule(method: MockMethodName, rule: MockFailureRule | null): void {
    if (!isMethodSupported(method)) {
      return;
    }
    if (!rule) {
      failureState.rules.delete(method);
      return;
    }
    failureState.rules.set(method, rule);
  }

  function clearFailureRules(): void {
    failureState.rules.clear();
    failureState.failedCountByMethod.clear();
  }

  function getCalls(method?: MockMethodName): ReadonlyArray<MockCallRecord> {
    if (!method) {
      return [...callRecords];
    }
    return callRecords.filter((record) => record.method === method);
  }

  function clearCalls(): void {
    callRecords.length = 0;
  }

  function seedQuotes(quotes: ReadonlyArray<{ readonly symbol: string; readonly quote: unknown }>): void {
    for (const item of quotes) {
      quoteBySymbol.set(item.symbol, item.quote);
    }
  }

  function seedStaticInfo(staticInfos: ReadonlyArray<{ readonly symbol: string; readonly info: unknown }>): void {
    for (const item of staticInfos) {
      staticInfoBySymbol.set(item.symbol, item.info);
    }
  }

  function seedCandlesticks(symbol: string, period: Period, candles: ReadonlyArray<Candlestick>): void {
    candlesticksByKey.set(createCandleKey(symbol, period), [...candles]);
  }

  function seedTradingDays(key: string, value: MarketTradingDays): void {
    tradingDaysByKey.set(key, value);
  }

  function seedWarrantQuotes(quotes: ReadonlyArray<WarrantQuote>): void {
    for (const quoteItem of quotes) {
      warrantQuoteBySymbol.set(quoteItem.symbol, quoteItem);
    }
  }

  function seedWarrantList(symbol: string, list: ReadonlyArray<WarrantInfo>): void {
    warrantListBySymbol.set(symbol, [...list]);
  }

  function emitQuote(event: PushQuoteEvent, options: EventPublishOptions = {}): void {
    bus.publish('quote', event, options);
  }

  function emitCandlestick(event: PushCandlestickEvent, options: EventPublishOptions = {}): void {
    bus.publish('candlestick', event, options);
  }

  function flushEvents(nowMs?: number): number {
    return bus.flushDue(nowMs);
  }

  function flushAllEvents(): number {
    return bus.flushAll();
  }

  function getSubscribedSymbols(): ReadonlySet<string> {
    return new Set(subscribedSymbols);
  }

  function getSubscribedCandlestickKeys(): ReadonlySet<string> {
    return new Set(subscribedCandlestickKeys);
  }

  return {
    quote,
    staticInfo,
    subscribe,
    unsubscribe,
    subscribeCandlesticks,
    unsubscribeCandlesticks,
    realtimeCandlesticks,
    tradingDays,
    warrantQuote,
    warrantList,
    setOnQuote,
    setOnCandlestick,
    setFailureRule,
    clearFailureRules,
    getCalls,
    clearCalls,
    seedQuotes,
    seedStaticInfo,
    seedCandlesticks,
    seedTradingDays,
    seedWarrantQuotes,
    seedWarrantList,
    emitQuote,
    emitCandlestick,
    flushEvents,
    flushAllEvents,
    getSubscribedSymbols,
    getSubscribedCandlestickKeys,
  };
}

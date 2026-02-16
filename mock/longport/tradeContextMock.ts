import {
  Decimal,
  OrderStatus,
  OrderType,
  type AccountBalance,
  type Execution,
  type GetHistoryOrdersOptions,
  type GetTodayExecutionsOptions,
  type GetTodayOrdersOptions,
  type Order,
  type OrderSide,
  type PushOrderChanged,
  type ReplaceOrderOptions,
  type StockPositionsResponse,
  type SubmitOrderOptions,
  type SubmitOrderResponse,
  type TopicType,
} from 'longport';
import { createLongportEventBus, type EventPublishOptions, type LongportEventBus } from './eventBus.js';
import type {
  MockCallRecord,
  MockFailureRule,
  MockMethodName,
  TradeContextContract,
} from './contracts.js';

const TRADE_METHODS: ReadonlySet<MockMethodName> = new Set([
  'submitOrder',
  'cancelOrder',
  'replaceOrder',
  'todayOrders',
  'historyOrders',
  'todayExecutions',
  'accountBalance',
  'stockPositions',
  'tradeSubscribe',
  'tradeUnsubscribe',
]);

type TradeContextMockOptions = {
  readonly eventBus?: LongportEventBus;
  readonly now?: () => number;
};

type FailureState = {
  readonly callsByMethod: Map<MockMethodName, number>;
  readonly failedCountByMethod: Map<MockMethodName, number>;
  readonly rules: Map<MockMethodName, MockFailureRule>;
};

type MinimalOrder = {
  orderId: string;
  status: OrderStatus;
  stockName: string;
  quantity: Decimal;
  executedQuantity: Decimal;
  price: Decimal;
  executedPrice: Decimal;
  submittedAt: Date;
  side: OrderSide;
  symbol: string;
  orderType: OrderType;
  updatedAt: Date;
};

function isMethodSupported(method: MockMethodName): boolean {
  return TRADE_METHODS.has(method);
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

function createOrderFromSubmit(
  orderId: string,
  options: SubmitOrderOptions,
  submittedAt: Date,
): MinimalOrder {
  const quantity = options.submittedQuantity;
  const price = options.submittedPrice ?? Decimal.ZERO();

  return {
    orderId,
    status: OrderStatus.New,
    stockName: options.symbol,
    quantity,
    executedQuantity: Decimal.ZERO(),
    price,
    executedPrice: Decimal.ZERO(),
    submittedAt,
    side: options.side,
    symbol: options.symbol,
    orderType: options.orderType,
    updatedAt: submittedAt,
  };
}

function cloneOrder(order: MinimalOrder): MinimalOrder {
  return {
    ...order,
    quantity: new Decimal(order.quantity.toString()),
    executedQuantity: new Decimal(order.executedQuantity.toString()),
    price: new Decimal(order.price.toString()),
    executedPrice: new Decimal(order.executedPrice.toString()),
    submittedAt: new Date(order.submittedAt),
    updatedAt: new Date(order.updatedAt),
  };
}

function asOrder(order: MinimalOrder): Order {
  // 信任边界：mock 按 Order 的核心字段构建，测试用例只依赖这些字段
  return order as unknown as Order;
}

function asPushEvent(event: PushOrderChanged | MinimalOrder): PushOrderChanged {
  if ('submittedQuantity' in event) {
    return event;
  }
  const converted = {
    orderId: event.orderId,
    symbol: event.symbol,
    stockName: event.stockName,
    side: event.side,
    orderType: event.orderType,
    submittedQuantity: event.quantity,
    submittedPrice: event.price,
    executedQuantity: event.executedQuantity,
    executedPrice: event.executedPrice,
    status: event.status,
    submittedAt: event.submittedAt,
    updatedAt: event.updatedAt,
    currency: 'HKD',
  };

  return converted as unknown as PushOrderChanged;
}

export interface TradeContextMock extends TradeContextContract {
  seedTodayOrders(orders: ReadonlyArray<Order>): void;
  seedHistoryOrders(orders: ReadonlyArray<Order>): void;
  seedTodayExecutions(executions: ReadonlyArray<Execution>): void;
  seedAccountBalances(balances: ReadonlyArray<AccountBalance>): void;
  seedStockPositions(response: StockPositionsResponse): void;
  emitOrderChanged(event: PushOrderChanged | MinimalOrder, options?: EventPublishOptions): void;
  flushEvents(nowMs?: number): number;
  flushAllEvents(): number;
  getSubscribedTopics(): ReadonlySet<TopicType>;
}

export function createTradeContextMock(options: TradeContextMockOptions = {}): TradeContextMock {
  const now = options.now ?? (() => Date.now());
  const bus = options.eventBus ?? createLongportEventBus(now);

  const failureState = createFailureState();
  const callRecords: MockCallRecord[] = [];

  let todayOrdersStore: MinimalOrder[] = [];
  let historyOrdersStore: MinimalOrder[] = [];
  let executionsStore: ReadonlyArray<Execution> = [];
  let balancesStore: ReadonlyArray<AccountBalance> = [];
  let stockPositionsStore: StockPositionsResponse = { channels: [] } as unknown as StockPositionsResponse;

  const subscribedTopics = new Set<TopicType>();
  let orderChangedDisposer: (() => void) | null = null;
  let orderCounter = 1;

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

  function submitOrder(optionsValue: SubmitOrderOptions): Promise<SubmitOrderResponse> {
    return withCall('submitOrder', [optionsValue], () => {
      const orderId = `MOCK-${String(orderCounter).padStart(6, '0')}`;
      orderCounter += 1;
      const createdAt = new Date(now());
      const order = createOrderFromSubmit(orderId, optionsValue, createdAt);
      todayOrdersStore.push(order);
      return { orderId } as unknown as SubmitOrderResponse;
    });
  }

  function cancelOrder(orderId: string): Promise<void> {
    return withCall('cancelOrder', [orderId], () => {
      todayOrdersStore = todayOrdersStore.map((order) => {
        if (order.orderId !== orderId) {
          return order;
        }
        return {
          ...order,
          status: OrderStatus.Canceled,
          updatedAt: new Date(now()),
        };
      });
    });
  }

  function replaceOrder(optionsValue: ReplaceOrderOptions): Promise<void> {
    return withCall('replaceOrder', [optionsValue], () => {
      todayOrdersStore = todayOrdersStore.map((order) => {
        if (order.orderId !== optionsValue.orderId) {
          return order;
        }

        const nextQuantity = optionsValue.quantity ?? order.quantity;
        const nextPrice = optionsValue.price ?? order.price;

        return {
          ...order,
          quantity: nextQuantity,
          price: nextPrice,
          status: OrderStatus.New,
          updatedAt: new Date(now()),
        };
      });
    });
  }

  function todayOrders(_options?: GetTodayOrdersOptions): Promise<ReadonlyArray<Order>> {
    return withCall('todayOrders', [_options], () => todayOrdersStore.map((order) => asOrder(cloneOrder(order))));
  }

  function historyOrders(_options?: GetHistoryOrdersOptions): Promise<ReadonlyArray<Order>> {
    return withCall('historyOrders', [_options], () => historyOrdersStore.map((order) => asOrder(cloneOrder(order))));
  }

  function todayExecutions(_options?: GetTodayExecutionsOptions): Promise<ReadonlyArray<Execution>> {
    return withCall('todayExecutions', [_options], () => [...executionsStore]);
  }

  function accountBalance(currency?: string): Promise<ReadonlyArray<AccountBalance>> {
    return withCall('accountBalance', [currency], () => {
      if (!currency) {
        return [...balancesStore];
      }
      return balancesStore.filter((balance) => balance.currency === currency);
    });
  }

  function stockPositions(symbols?: ReadonlyArray<string>): Promise<StockPositionsResponse> {
    return withCall('stockPositions', [symbols], () => {
      if (!symbols || symbols.length === 0) {
        return stockPositionsStore;
      }

      const symbolSet = new Set(symbols);
      const channels = stockPositionsStore.channels.map((channel) => ({
        ...channel,
        positions: channel.positions.filter((position) => symbolSet.has(position.symbol)),
      }));

      return { channels } as StockPositionsResponse;
    });
  }

  function setOnOrderChanged(callback: (err: Error | null, event: PushOrderChanged) => void): void {
    orderChangedDisposer?.();
    orderChangedDisposer = bus.subscribe('orderChanged', (payload) => {
      callback(null, payload);
    });
  }

  function subscribe(topics: ReadonlyArray<TopicType>): Promise<void> {
    return withCall('tradeSubscribe', [topics], () => {
      for (const topic of topics) {
        subscribedTopics.add(topic);
      }
    });
  }

  function unsubscribe(topics: ReadonlyArray<TopicType>): Promise<void> {
    return withCall('tradeUnsubscribe', [topics], () => {
      for (const topic of topics) {
        subscribedTopics.delete(topic);
      }
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

  function seedTodayOrders(orders: ReadonlyArray<Order>): void {
    todayOrdersStore = orders.map((order) => {
      const typed = order as unknown as MinimalOrder;
      return cloneOrder(typed);
    });
  }

  function seedHistoryOrders(orders: ReadonlyArray<Order>): void {
    historyOrdersStore = orders.map((order) => {
      const typed = order as unknown as MinimalOrder;
      return cloneOrder(typed);
    });
  }

  function seedTodayExecutions(executions: ReadonlyArray<Execution>): void {
    executionsStore = [...executions];
  }

  function seedAccountBalances(balances: ReadonlyArray<AccountBalance>): void {
    balancesStore = [...balances];
  }

  function seedStockPositions(response: StockPositionsResponse): void {
    stockPositionsStore = response;
  }

  function emitOrderChanged(
    event: PushOrderChanged | MinimalOrder,
    options: EventPublishOptions = {},
  ): void {
    bus.publish('orderChanged', asPushEvent(event), options);
  }

  function flushEvents(nowMs?: number): number {
    return bus.flushDue(nowMs);
  }

  function flushAllEvents(): number {
    return bus.flushAll();
  }

  function getSubscribedTopics(): ReadonlySet<TopicType> {
    return new Set(subscribedTopics);
  }

  return {
    submitOrder,
    cancelOrder,
    replaceOrder,
    todayOrders,
    historyOrders,
    todayExecutions,
    accountBalance,
    stockPositions,
    setOnOrderChanged,
    subscribe,
    unsubscribe,
    setFailureRule,
    clearFailureRules,
    getCalls,
    clearCalls,
    seedTodayOrders,
    seedHistoryOrders,
    seedTodayExecutions,
    seedAccountBalances,
    seedStockPositions,
    emitOrderChanged,
    flushEvents,
    flushAllEvents,
    getSubscribedTopics,
  };
}

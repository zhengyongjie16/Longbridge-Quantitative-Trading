/**
 * 交易上下文 Mock
 *
 * 功能：
 * - 模拟 TradeContext 的下单链路、查询接口、失败注入与事件推送
 */
import {
  Decimal,
  OrderStatus,
  type AccountBalance,
  type Execution,
  type GetHistoryOrdersOptions,
  type GetTodayExecutionsOptions,
  type GetTodayOrdersOptions,
  type Order,
  type OrderType,
  type OrderSide,
  type PushOrderChanged,
  type ReplaceOrderOptions,
  type StockPositionsResponse,
  type SubmitOrderOptions,
  type SubmitOrderResponse,
  type TopicType,
} from 'longport';
import {
  createLongportEventBus,
  type EventPublishOptions,
  type LongportEventBus,
} from './eventBus.js';
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

/**
 * 校验方法名是否属于 TradeContext Mock 支持的能力集合。
 *
 * 用于失败注入入口防御，避免无效方法写入状态。
 */
function isMethodSupported(method: MockMethodName): boolean {
  return TRADE_METHODS.has(method);
}

/**
 * 初始化失败注入运行态。
 *
 * 将调用计数、失败计数与规则拆分维护，方便测试按需重置。
 */
function createFailureState(): FailureState {
  return {
    callsByMethod: new Map(),
    failedCountByMethod: new Map(),
    rules: new Map(),
  };
}

/**
 * 递增并返回指定方法的调用序号。
 *
 * 失败规则按调用次数命中时依赖该序号保证可重复性。
 */
function nextCallIndex(state: FailureState, method: MockMethodName): number {
  const next = (state.callsByMethod.get(method) ?? 0) + 1;
  state.callsByMethod.set(method, next);
  return next;
}

/**
 * 根据失败注入规则判断当前调用是否应抛出错误。
 *
 * 支持按调用序号列表、固定间隔和自定义谓词三种匹配方式，
 * 并通过 `maxFailures` 限制最大失败次数，防止测试无限失败。
 */
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

/**
 * 将 submitOrder 入参转换为内部最小订单结构。
 *
 * 统一初始状态字段，确保后续改单/撤单流程操作同一数据模型。
 */
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

/**
 * 深拷贝内部订单对象。
 *
 * 避免 Decimal 与 Date 引用被共享，防止测试间状态串扰。
 */
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

/**
 * 在信任边界将内部订单转为 SDK Order 类型。
 *
 * mock 仅维护测试依赖字段，类型断言用于缩小样板代码。
 */
function asOrder(order: MinimalOrder): Order {
  // 信任边界：mock 按 Order 的核心字段构建，测试用例只依赖这些字段
  return order as unknown as Order;
}

/**
 * 将内部订单或外部推送统一转换为 PushOrderChanged 事件。
 *
 * 复用同一推送路径，确保手动 emit 与真实回放行为一致。
 */
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

/**
 * 根据 symbols 白名单过滤持仓响应。
 *
 * 用于 stockPositions 查询分支，避免在调用包装回调中形成深层函数嵌套。
 */
function filterStockPositionsBySymbols(
  stockPositions: StockPositionsResponse,
  symbols: ReadonlyArray<string>,
): StockPositionsResponse {
  const symbolSet = new Set(symbols);
  const channels = stockPositions.channels.map((channel) => {
    const filteredPositions = channel.positions.filter((position) => symbolSet.has(position.symbol));
    const channelObject = channel as object;
    const channelPrototype = Object.getPrototypeOf(channelObject) as object | null;
    const channelClone = Object.create(channelPrototype ?? Object.prototype) as object;
    return Object.assign(channelClone, channelObject, {
      positions: filteredPositions,
    }) as StockPositionsResponse['channels'][number];
  });
  return { channels } as StockPositionsResponse;
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

/**
 * 创建 TradeContext 的测试替身。
 *
 * 用于在不依赖真实交易网关的情况下，模拟下单、改单、撤单、查询与推送链路，
 * 并支持失败注入以验证重试与容错逻辑。
 */
export function createTradeContextMock(options: TradeContextMockOptions = {}): TradeContextMock {
  const now = options.now ?? (() => Date.now());
  const bus = options.eventBus ?? createLongportEventBus(now);

  const failureState = createFailureState();
  const callRecords: MockCallRecord[] = [];

  let todayOrdersStore: MinimalOrder[] = [];
  let historyOrdersStore: MinimalOrder[] = [];
  let executionsStore: ReadonlyArray<Execution> = [];
  let balancesStore: ReadonlyArray<AccountBalance> = [];
  let stockPositionsStore: StockPositionsResponse = {
    channels: [],
  } as unknown as StockPositionsResponse;

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

  /**
   * 统一封装调用计数、失败注入与调用记录。
   *
   * 所有对外能力均经此路径，确保失败注入与调用日志语义一致，避免各方法行为漂移。
   */
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

        const nextQuantity = optionsValue.quantity;
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
    return withCall('todayOrders', [_options], () =>
      todayOrdersStore.map((order) => asOrder(cloneOrder(order))),
    );
  }

  function historyOrders(_options?: GetHistoryOrdersOptions): Promise<ReadonlyArray<Order>> {
    return withCall('historyOrders', [_options], () =>
      historyOrdersStore.map((order) => asOrder(cloneOrder(order))),
    );
  }

  function todayExecutions(
    _options?: GetTodayExecutionsOptions,
  ): Promise<ReadonlyArray<Execution>> {
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
      return filterStockPositionsBySymbols(stockPositionsStore, symbols);
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

/**
 * orderMonitor route runtime 业务测试
 *
 * 功能：
 * - 验证按 symbol 路由的 quote 唤醒、dirty collapse 与 stopAndDrain 行为。
 */
import { describe, expect, it } from 'bun:test';
import { OrderSide, OrderStatus, OrderType } from 'longbridge';
import {
  ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS,
  TIME,
} from '../../../../src/constants/index.js';
import { createMarketDataClientDouble, createQuoteDouble } from '../../../helpers/testDoubles.js';
import { createRouteRuntime } from '../../../../src/core/trader/orderMonitor/routeRuntime.js';
import type {
  OrderMonitorRuntimeStore,
  OrderMonitorSymbolRouteState,
  OrderMonitorTrackedOrder,
  RouteRuntimeDeps,
} from '../../../../src/core/trader/orderMonitor/types.js';
import type { QuoteUpdatedEvent } from '../../../../src/types/services.js';

const routeConfig: RouteRuntimeDeps['config'] = {
  buyTimeout: { enabled: true, timeoutMs: 0 },
  sellTimeout: { enabled: true, timeoutMs: 0 },
  priceUpdateIntervalMs: 0,
  priceDiffThreshold: 0.001,
  allowBuyOrderTrackingAboveInitialPrice: true,
};

function createDeferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve: resolvePromise,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

type RuntimeTimerHarness = {
  readonly advanceBy: (delayMs: number) => Promise<void>;
  readonly getPendingTimerAts: () => ReadonlyArray<number>;
  readonly restore: () => void;
};

function createRuntimeTimerHarness(initialNowMs: number): RuntimeTimerHarness {
  const originalNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let nowMs = initialNowMs;
  const timers = new Map<unknown, { readonly atMs: number; readonly callback: () => void }>();

  function isTimerCallback(
    handler: Parameters<typeof globalThis.setTimeout>[0],
  ): handler is (...args: ReadonlyArray<unknown>) => void {
    return typeof handler === 'function';
  }

  const fakeSetTimeout = Object.assign(
    (
      handler: Parameters<typeof globalThis.setTimeout>[0],
      timeout?: number,
    ): ReturnType<typeof originalSetTimeout> => {
      if (!isTimerCallback(handler)) {
        throw new TypeError('[测试] fake runtime timer 仅支持函数回调');
      }

      const handle = originalSetTimeout(() => {}, 0);
      originalClearTimeout(handle);
      timers.set(handle, {
        atMs: nowMs + (typeof timeout === 'number' ? timeout : 0),
        callback: () => {
          handler();
        },
      });
      return handle;
    },
    {
      __promisify__: originalSetTimeout.__promisify__,
    },
  );

  const fakeClearTimeout: typeof globalThis.clearTimeout = (handle) => {
    timers.delete(handle);
  };

  Date.now = () => nowMs;
  globalThis.setTimeout = fakeSetTimeout;
  globalThis.clearTimeout = fakeClearTimeout;

  return {
    advanceBy: async (delayMs: number) => {
      nowMs += delayMs;
      const dueTimers = [...timers.entries()].filter(([, timer]) => timer.atMs <= nowMs);
      for (const [handle, timer] of dueTimers) {
        timers.delete(handle);
        timer.callback();
      }

      await flushMicrotasks();
      await flushMicrotasks();
    },
    getPendingTimerAts: () => [...timers.values()].map((timer) => timer.atMs),
    restore: () => {
      Date.now = originalNow;
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
  };
}

async function expectPromiseRejectsToMatch(
  operation: () => Promise<unknown>,
  expectedMessagePattern: RegExp,
): Promise<void> {
  try {
    await operation();
  } catch (error: unknown) {
    if (!(error instanceof Error)) {
      throw new Error(`[测试] 预期 Promise 以 Error 拒绝，实际为: ${String(error)}`, {
        cause: error,
      });
    }

    expect(error.message).toMatch(expectedMessagePattern);
    return;
  }

  throw new Error('[测试] 预期 Promise 拒绝，但实际成功');
}

function createRouteState(symbol: string, generation: number = 1): OrderMonitorSymbolRouteState {
  return {
    symbol,
    generation,
    inFlight: false,
    dirty: false,
    latestQuote: null,
    pendingWakeupKind: null,
    timerHandles: new Map(),
  };
}

function createRuntimeStore(): OrderMonitorRuntimeStore {
  return {
    trackedOrders: new Map(),
    trackedOrderLifecycles: new Map(),
    bootstrappingOrderEvents: new Map(),
    closedOrderIds: new Set(),
    queriedTerminalStateByOrderId: new Map(),
    latestReplaceOutcomeByOrderId: new Map(),
    orderStateChangedListeners: new Set(),
    trackedOrderIdsBySymbol: new Map(),
    routeStatesBySymbol: new Map(),
    latestRouteGenerationBySymbol: new Map(),
    runtimeState: 'ACTIVE',
    running: false,
    unsubscribeQuoteUpdated: null,
  };
}

function createTrackedOrder(
  params: Partial<OrderMonitorTrackedOrder> &
    Pick<OrderMonitorTrackedOrder, 'orderId' | 'symbol' | 'side'>,
): OrderMonitorTrackedOrder {
  const now = Date.now();
  return {
    orderId: params.orderId,
    symbol: params.symbol,
    side: params.side,
    isLongSymbol: params.isLongSymbol ?? true,
    monitorSymbol: params.monitorSymbol ?? 'HSI.HK',
    isProtectiveLiquidation: params.isProtectiveLiquidation ?? false,
    liquidationTriggerLimit: params.liquidationTriggerLimit ?? 1,
    liquidationCooldownConfig: params.liquidationCooldownConfig ?? null,
    orderType: params.orderType ?? OrderType.ELO,
    submittedPrice: params.submittedPrice ?? 1,
    initialSubmittedPrice: params.initialSubmittedPrice ?? 1,
    submittedQuantity: params.submittedQuantity ?? 100,
    executedQuantity: params.executedQuantity ?? 0,
    executedPrice: params.executedPrice ?? null,
    lastExecutedTimeMs: params.lastExecutedTimeMs ?? null,
    status: params.status ?? OrderStatus.New,
    submittedAt: params.submittedAt ?? now - 5_000,
    lastPriceUpdateAt: params.lastPriceUpdateAt ?? now - 5_000,
    convertedToMarket: params.convertedToMarket ?? false,
    nextCancelAttemptAt: params.nextCancelAttemptAt ?? now - 1,
    cancelRetryCount: params.cancelRetryCount ?? 0,
    replaceCapability: params.replaceCapability ?? 'SUPPORTED',
    replaceBlockedUntilAt: params.replaceBlockedUntilAt ?? null,
    quoteRetryAttempts: params.quoteRetryAttempts ?? 0,
    quoteRetryNextAt: params.quoteRetryNextAt ?? null,
    quoteRetryExhausted: params.quoteRetryExhausted ?? false,
    replaceTempBlockedCount: params.replaceTempBlockedCount ?? 0,
    replaceResumeMode: params.replaceResumeMode ?? 'TIME_BACKOFF',
    timeoutMarketConversionPending: params.timeoutMarketConversionPending ?? false,
    timeoutMarketConversionTerminalState: params.timeoutMarketConversionTerminalState ?? null,
  };
}

function attachTrackedOrder(
  runtime: OrderMonitorRuntimeStore,
  order: OrderMonitorTrackedOrder,
): void {
  runtime.trackedOrders.set(order.orderId, order);
  runtime.trackedOrderLifecycles.set(order.orderId, 'OPEN');
  runtime.trackedOrderIdsBySymbol.set(order.symbol, new Set([order.orderId]));
  if (!runtime.latestRouteGenerationBySymbol.has(order.symbol)) {
    runtime.latestRouteGenerationBySymbol.set(order.symbol, 1);
  }
}

function createQuoteEmitter(): {
  readonly marketDataClient: ReturnType<typeof createMarketDataClientDouble>;
  readonly emitQuote: (event: QuoteUpdatedEvent) => void;
} {
  let quoteListener: ((event: QuoteUpdatedEvent) => void) | null = null;

  return {
    marketDataClient: createMarketDataClientDouble({
      onQuoteUpdated: (listener) => {
        quoteListener = listener;
        return () => {
          quoteListener = null;
        };
      },
    }),
    emitQuote: (event) => {
      quoteListener?.(event);
    },
  };
}

describe('orderMonitor route runtime', () => {
  it('只唤醒目标 symbol route', async () => {
    const runtime = createRuntimeStore();
    runtime.routeStatesBySymbol.set('BULL.HK', createRouteState('BULL.HK'));
    runtime.routeStatesBySymbol.set('BEAR.HK', createRouteState('BEAR.HK'));
    const processedSymbols: string[] = [];
    const { marketDataClient, emitQuote } = createQuoteEmitter();
    const routeRuntime = createRouteRuntime({
      runtime,
      config: routeConfig,
      marketDataClient,
      processRoute: async ({ symbol }) => {
        processedSymbols.push(symbol);
      },
    });

    routeRuntime.start();
    emitQuote({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', 1.01),
    });
    await flushMicrotasks();

    expect(processedSymbols).toEqual(['BULL.HK']);
    expect(runtime.routeStatesBySymbol.get('BULL.HK')?.latestQuote?.price).toBe(1.01);
    expect(runtime.routeStatesBySymbol.get('BEAR.HK')?.latestQuote).toBeNull();
  });

  it('route 不存在时 quote 不触发处理', async () => {
    const runtime = createRuntimeStore();
    const processedSymbols: string[] = [];
    const { marketDataClient, emitQuote } = createQuoteEmitter();
    const routeRuntime = createRouteRuntime({
      runtime,
      config: routeConfig,
      marketDataClient,
      processRoute: async ({ symbol }) => {
        processedSymbols.push(symbol);
      },
    });

    routeRuntime.start();
    emitQuote({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', 1.01),
    });
    await flushMicrotasks();

    expect(processedSymbols).toEqual([]);
  });

  it('in-flight 时合并 dirty 并在完成后补跑一轮', async () => {
    const runtime = createRuntimeStore();
    runtime.routeStatesBySymbol.set('BULL.HK', createRouteState('BULL.HK'));
    const firstPassEntered = createDeferred();
    const releaseFirstPass = createDeferred();
    let processCount = 0;
    const { marketDataClient, emitQuote } = createQuoteEmitter();
    const routeRuntime = createRouteRuntime({
      runtime,
      config: routeConfig,
      marketDataClient,
      processRoute: async () => {
        processCount += 1;
        if (processCount === 1) {
          firstPassEntered.resolve();
          await releaseFirstPass.promise;
        }
      },
    });

    routeRuntime.start();
    emitQuote({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', 1.01),
    });
    await firstPassEntered.promise;

    emitQuote({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', 1.02),
    });

    emitQuote({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', 1.03),
    });
    await flushMicrotasks();

    expect(processCount).toBe(1);
    expect(runtime.routeStatesBySymbol.get('BULL.HK')?.dirty).toBe(true);
    expect(runtime.routeStatesBySymbol.get('BULL.HK')?.latestQuote?.price).toBe(1.03);

    releaseFirstPass.resolve();
    await flushMicrotasks();

    expect(processCount).toBe(2);
    expect(runtime.routeStatesBySymbol.get('BULL.HK')?.dirty).toBe(false);
  });

  it('in-flight 期间收到新唤醒时补跑使用最新唤醒原因', async () => {
    const runtime = createRuntimeStore();
    runtime.routeStatesBySymbol.set('BULL.HK', createRouteState('BULL.HK'));
    const firstPassEntered = createDeferred();
    const releaseFirstPass = createDeferred();
    const wakeupKinds: string[] = [];
    const { marketDataClient } = createQuoteEmitter();
    const routeRuntime = createRouteRuntime({
      runtime,
      config: routeConfig,
      marketDataClient,
      processRoute: async ({ wakeupKind }) => {
        wakeupKinds.push(wakeupKind);
        if (wakeupKinds.length === 1) {
          firstPassEntered.resolve();
          await releaseFirstPass.promise;
        }
      },
    });

    routeRuntime.start();
    routeRuntime.triggerRoute('BULL.HK', 'ORDER_EVENT');
    await firstPassEntered.promise;

    routeRuntime.triggerRoute('BULL.HK', 'RECOVERED');
    releaseFirstPass.resolve();
    await flushMicrotasks();

    expect(wakeupKinds).toEqual(['ORDER_EVENT', 'RECOVERED']);
  });

  it('start 时会为已有 tracked symbol 触发 RECOVERED bootstrapping', async () => {
    const runtime = createRuntimeStore();
    runtime.routeStatesBySymbol.set('BULL.HK', createRouteState('BULL.HK'));
    attachTrackedOrder(
      runtime,
      createTrackedOrder({
        orderId: 'RECOVERED-START-1',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
        nextCancelAttemptAt: ORDER_MONITOR_WAIT_WS_ONLY_BLOCK_UNTIL_MS,
      }),
    );
    const wakeupKinds: string[] = [];
    const { marketDataClient } = createQuoteEmitter();
    const routeRuntime = createRouteRuntime({
      runtime,
      config: {
        ...routeConfig,
        buyTimeout: { enabled: false, timeoutMs: 0 },
        sellTimeout: { enabled: false, timeoutMs: 0 },
      },
      marketDataClient,
      processRoute: async ({ wakeupKind }) => {
        wakeupKinds.push(wakeupKind);
      },
    });

    routeRuntime.start();
    await flushMicrotasks();

    expect(wakeupKinds).toEqual(['RECOVERED']);
  });

  it('start 不会回放 stopped-state 的普通唤醒', async () => {
    const runtime = createRuntimeStore();
    runtime.routeStatesBySymbol.set('BULL.HK', createRouteState('BULL.HK'));
    const wakeupKinds: string[] = [];
    const { marketDataClient } = createQuoteEmitter();
    const routeRuntime = createRouteRuntime({
      runtime,
      config: routeConfig,
      marketDataClient,
      processRoute: async ({ wakeupKind }) => {
        wakeupKinds.push(wakeupKind);
      },
    });

    routeRuntime.start();
    await routeRuntime.stopAndDrain();
    routeRuntime.triggerRoute('BULL.HK', 'ORDER_EVENT');
    routeRuntime.start();
    await flushMicrotasks();

    expect(wakeupKinds).toEqual([]);
  });

  it('BOOTSTRAPPING 阶段 start 后 quote 不会推进 route，也不会写入 latestQuote', async () => {
    const runtime = createRuntimeStore();
    runtime.runtimeState = 'BOOTSTRAPPING';
    runtime.routeStatesBySymbol.set('BULL.HK', createRouteState('BULL.HK'));
    attachTrackedOrder(
      runtime,
      createTrackedOrder({
        orderId: 'BOOTSTRAPPING-QUOTE-IGNORED',
        symbol: 'BULL.HK',
        side: OrderSide.Buy,
      }),
    );
    const wakeupKinds: string[] = [];
    const { marketDataClient, emitQuote } = createQuoteEmitter();
    const routeRuntime = createRouteRuntime({
      runtime,
      config: routeConfig,
      marketDataClient,
      processRoute: async ({ wakeupKind }) => {
        wakeupKinds.push(wakeupKind);
      },
    });

    routeRuntime.start();
    emitQuote({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', 1.01),
    });
    await flushMicrotasks();

    expect(wakeupKinds).toEqual([]);
    expect(runtime.routeStatesBySymbol.get('BULL.HK')?.latestQuote).toBeNull();
  });

  it('stopAndDrain 后旧 quote 事件不再推进', async () => {
    const runtime = createRuntimeStore();
    runtime.routeStatesBySymbol.set('BULL.HK', createRouteState('BULL.HK'));
    const processedSymbols: string[] = [];
    const { marketDataClient, emitQuote } = createQuoteEmitter();
    const routeRuntime = createRouteRuntime({
      runtime,
      config: routeConfig,
      marketDataClient,
      processRoute: async ({ symbol }) => {
        processedSymbols.push(symbol);
      },
    });

    routeRuntime.start();
    await routeRuntime.stopAndDrain();
    emitQuote({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', 1.01),
    });
    await flushMicrotasks();

    expect(processedSymbols).toEqual([]);
    expect(runtime.running).toBe(false);
    expect(runtime.unsubscribeQuoteUpdated).toBeNull();
  });

  it('stopAndDrain 会清空 route 缓存的 latestQuote，避免重启沿用 stale quote', async () => {
    const runtime = createRuntimeStore();
    runtime.routeStatesBySymbol.set('BULL.HK', {
      ...createRouteState('BULL.HK'),
      latestQuote: createQuoteDouble('BULL.HK', 1.02),
    });
    const { marketDataClient } = createQuoteEmitter();
    const routeRuntime = createRouteRuntime({
      runtime,
      config: routeConfig,
      marketDataClient,
      processRoute: async () => {},
    });

    await routeRuntime.stopAndDrain();

    expect(runtime.routeStatesBySymbol.get('BULL.HK')?.latestQuote).toBeNull();
  });

  it('stopAndDrain 会清空脏位并推进 route generation', async () => {
    const runtime = createRuntimeStore();
    runtime.routeStatesBySymbol.set('BULL.HK', createRouteState('BULL.HK', 3));
    const firstPassEntered = createDeferred();
    const releaseFirstPass = createDeferred();
    const processedGenerations: number[] = [];
    const { marketDataClient } = createQuoteEmitter();
    const routeRuntime = createRouteRuntime({
      runtime,
      config: routeConfig,
      marketDataClient,
      processRoute: async ({ generation }) => {
        processedGenerations.push(generation);
        firstPassEntered.resolve();
        await releaseFirstPass.promise;
      },
    });

    routeRuntime.start();
    routeRuntime.triggerRoute('BULL.HK', 'ORDER_EVENT');
    await firstPassEntered.promise;
    routeRuntime.triggerRoute('BULL.HK', 'QUOTE');

    const stopPromise = routeRuntime.stopAndDrain();
    releaseFirstPass.resolve();
    await stopPromise;

    expect(runtime.routeStatesBySymbol.get('BULL.HK')?.dirty).toBe(false);
    expect(runtime.routeStatesBySymbol.get('BULL.HK')?.inFlight).toBe(false);
    expect(runtime.routeStatesBySymbol.get('BULL.HK')?.generation).toBe(4);
    expect(runtime.latestRouteGenerationBySymbol.get('BULL.HK')).toBe(4);
    expect(processedGenerations).toEqual([3]);
  });

  it('start 时会为 nextCancelAttemptAt 投影 CANCEL_RETRY timer', async () => {
    const runtime = createRuntimeStore();
    const now = Date.now();
    attachTrackedOrder(
      runtime,
      createTrackedOrder({
        orderId: 'SELL-CANCEL-RETRY-TIMER',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        submittedAt: now - 1_000,
        nextCancelAttemptAt: now + 5_000,
      }),
    );
    runtime.routeStatesBySymbol.set('BULL.HK', createRouteState('BULL.HK'));
    const { marketDataClient } = createQuoteEmitter();
    const routeRuntime = createRouteRuntime({
      runtime,
      config: routeConfig,
      marketDataClient,
      processRoute: async () => {},
    });

    routeRuntime.start();
    await flushMicrotasks();

    expect(
      runtime.routeStatesBySymbol
        .get('BULL.HK')
        ?.timerHandles.has('SELL-CANCEL-RETRY-TIMER:CANCEL_RETRY'),
    ).toBe(true);
  });

  it('start 时会为 quoteRetryNextAt 投影 QUOTE_RETRY timer', async () => {
    const runtime = createRuntimeStore();
    const now = Date.now();
    attachTrackedOrder(
      runtime,
      createTrackedOrder({
        orderId: 'SELL-QUOTE-RETRY-TIMER',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        submittedAt: now - 1_000,
        quoteRetryAttempts: 1,
        quoteRetryNextAt: now + 5_000,
      }),
    );
    runtime.routeStatesBySymbol.set('BULL.HK', createRouteState('BULL.HK'));
    const { marketDataClient } = createQuoteEmitter();
    const routeRuntime = createRouteRuntime({
      runtime,
      config: routeConfig,
      marketDataClient,
      processRoute: async () => {},
    });

    routeRuntime.start();
    await flushMicrotasks();

    expect(
      runtime.routeStatesBySymbol
        .get('BULL.HK')
        ?.timerHandles.has('SELL-QUOTE-RETRY-TIMER:QUOTE_RETRY'),
    ).toBe(true);
  });

  it('超长 route timer 只注册最大安全分段，到真实 due 后才触发 TIMER wakeup', async () => {
    const initialNowMs = Date.parse('2026-04-09T09:30:00.000Z');
    const timerHarness = createRuntimeTimerHarness(initialNowMs);

    try {
      const runtime = createRuntimeStore();
      attachTrackedOrder(
        runtime,
        createTrackedOrder({
          orderId: 'SELL-CANCEL-RETRY-LONG-TIMER',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          submittedAt: initialNowMs - 1_000,
          nextCancelAttemptAt: initialNowMs + TIME.MAX_TIMER_DELAY_MS + 5,
        }),
      );
      runtime.routeStatesBySymbol.set('BULL.HK', createRouteState('BULL.HK'));
      const wakeupKinds: string[] = [];
      const { marketDataClient } = createQuoteEmitter();
      const routeRuntime = createRouteRuntime({
        runtime,
        config: {
          ...routeConfig,
          buyTimeout: { enabled: false, timeoutMs: 0 },
          sellTimeout: { enabled: false, timeoutMs: 0 },
        },
        marketDataClient,
        processRoute: async ({ wakeupKind }) => {
          wakeupKinds.push(wakeupKind);
        },
      });

      routeRuntime.start();
      await flushMicrotasks();

      expect(timerHarness.getPendingTimerAts()).toEqual([initialNowMs + TIME.MAX_TIMER_DELAY_MS]);

      await timerHarness.advanceBy(TIME.MAX_TIMER_DELAY_MS);
      expect(wakeupKinds).toEqual(['RECOVERED']);
      expect(timerHarness.getPendingTimerAts()).toEqual([
        initialNowMs + TIME.MAX_TIMER_DELAY_MS + 5,
      ]);

      await timerHarness.advanceBy(5);
      expect(wakeupKinds).toEqual(['RECOVERED', 'TIMER']);
      await routeRuntime.stopAndDrain();
    } finally {
      timerHarness.restore();
    }
  });

  it('start 时即使 quoteRetryExhausted=true，只要存在 quoteRetryNextAt 仍会投影 QUOTE_RETRY timer', async () => {
    const runtime = createRuntimeStore();
    const now = Date.now();
    attachTrackedOrder(
      runtime,
      createTrackedOrder({
        orderId: 'SELL-QUOTE-RETRY-EXHAUSTED-TIMER',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        submittedAt: now - 1_000,
        quoteRetryAttempts: 5,
        quoteRetryNextAt: now + 5_000,
        quoteRetryExhausted: true,
      }),
    );
    runtime.routeStatesBySymbol.set('BULL.HK', createRouteState('BULL.HK'));
    const { marketDataClient } = createQuoteEmitter();
    const routeRuntime = createRouteRuntime({
      runtime,
      config: routeConfig,
      marketDataClient,
      processRoute: async () => {},
    });

    routeRuntime.start();
    await flushMicrotasks();

    expect(
      runtime.routeStatesBySymbol
        .get('BULL.HK')
        ?.timerHandles.has('SELL-QUOTE-RETRY-EXHAUSTED-TIMER:QUOTE_RETRY'),
    ).toBe(true);
  });

  it('overdue timer 在 start 后不会丢失，会立即触发 TIMER wakeup', async () => {
    const timerHarness = createRuntimeTimerHarness(Date.parse('2026-04-09T09:30:00.000Z'));

    try {
      const runtime = createRuntimeStore();
      const now = Date.now();
      attachTrackedOrder(
        runtime,
        createTrackedOrder({
          orderId: 'SELL-OVERDUE-CANCEL-RETRY',
          symbol: 'BULL.HK',
          side: OrderSide.Sell,
          submittedAt: now - 1_000,
          nextCancelAttemptAt: now - 1,
        }),
      );
      runtime.routeStatesBySymbol.set('BULL.HK', createRouteState('BULL.HK'));
      const wakeupKinds: string[] = [];
      const { marketDataClient } = createQuoteEmitter();
      const routeRuntime = createRouteRuntime({
        runtime,
        config: {
          ...routeConfig,
          buyTimeout: { enabled: false, timeoutMs: 0 },
          sellTimeout: { enabled: false, timeoutMs: 0 },
        },
        marketDataClient,
        processRoute: async ({ wakeupKind }) => {
          wakeupKinds.push(wakeupKind);
        },
      });

      routeRuntime.start();
      await flushMicrotasks();

      expect(wakeupKinds).toEqual(['RECOVERED']);

      await timerHarness.advanceBy(0);
      expect(wakeupKinds).toEqual(['RECOVERED', 'TIMER']);
      await routeRuntime.stopAndDrain();
    } finally {
      timerHarness.restore();
    }
  });

  it('同 key timer 的计划时间变化后会重建 timer，而不是沿用旧计划', async () => {
    const timerHarness = createRuntimeTimerHarness(Date.parse('2026-04-09T09:30:00.000Z'));

    try {
      const runtime = createRuntimeStore();
      const now = Date.now();
      const trackedOrder = createTrackedOrder({
        orderId: 'SELL-CANCEL-RETRY-RESCHEDULE',
        symbol: 'BULL.HK',
        side: OrderSide.Sell,
        submittedAt: now - 1_000,
        nextCancelAttemptAt: now + 120,
      });
      attachTrackedOrder(runtime, trackedOrder);
      runtime.routeStatesBySymbol.set('BULL.HK', createRouteState('BULL.HK'));
      const processedWakeupKinds: string[] = [];
      const { marketDataClient } = createQuoteEmitter();
      const routeRuntime = createRouteRuntime({
        runtime,
        config: {
          ...routeConfig,
          buyTimeout: { enabled: false, timeoutMs: 0 },
          sellTimeout: { enabled: false, timeoutMs: 0 },
        },
        marketDataClient,
        processRoute: async ({ wakeupKind }) => {
          processedWakeupKinds.push(wakeupKind);
        },
      });

      routeRuntime.start();
      trackedOrder.nextCancelAttemptAt = Date.now() + 280;
      routeRuntime.triggerRoute('BULL.HK', 'ORDER_EVENT');
      await flushMicrotasks();

      const rescheduledTimer = runtime.routeStatesBySymbol
        .get('BULL.HK')
        ?.timerHandles.get('SELL-CANCEL-RETRY-RESCHEDULE:CANCEL_RETRY');
      expect(rescheduledTimer?.atMs).toBe(trackedOrder.nextCancelAttemptAt);

      await timerHarness.advanceBy(180);
      expect(processedWakeupKinds).toEqual(['RECOVERED', 'ORDER_EVENT']);

      await timerHarness.advanceBy(160);
      expect(processedWakeupKinds).toEqual(['RECOVERED', 'ORDER_EVENT', 'TIMER']);
    } finally {
      timerHarness.restore();
    }
  });

  it('stopAndDrain 会向调用方暴露 route 处理失败', async () => {
    const runtime = createRuntimeStore();
    runtime.routeStatesBySymbol.set('BULL.HK', createRouteState('BULL.HK'));
    const firstPassEntered = createDeferred();
    const releaseFirstPass = createDeferred();
    const { marketDataClient } = createQuoteEmitter();
    const routeRuntime = createRouteRuntime({
      runtime,
      config: routeConfig,
      marketDataClient,
      processRoute: async () => {
        firstPassEntered.resolve();
        await releaseFirstPass.promise;
        throw new Error('route process failed');
      },
    });

    routeRuntime.start();
    routeRuntime.triggerRoute('BULL.HK', 'ORDER_EVENT');
    await firstPassEntered.promise;

    const stopPromise = routeRuntime.stopAndDrain();
    releaseFirstPass.resolve();

    await expectPromiseRejectsToMatch(() => stopPromise, /route process failed/);
  });

  it('route 处理失败会在运行期进入 fatal 通道', async () => {
    const runtime = createRuntimeStore();
    runtime.routeStatesBySymbol.set('BULL.HK', createRouteState('BULL.HK'));
    const routeError = new Error('route runtime fatal failure');
    const fatalErrors: unknown[] = [];
    const { marketDataClient } = createQuoteEmitter();
    const routeRuntime = createRouteRuntime({
      runtime,
      config: routeConfig,
      marketDataClient,
      processRoute: async () => {
        throw routeError;
      },
      onFatalError: (error) => {
        fatalErrors.push(error);
      },
    });

    routeRuntime.start();
    routeRuntime.triggerRoute('BULL.HK', 'ORDER_EVENT');
    await flushMicrotasks();

    expect(fatalErrors).toEqual([routeError]);
  });

  it('stopAndDrain 不会重复暴露同一条 route 失败', async () => {
    const runtime = createRuntimeStore();
    runtime.routeStatesBySymbol.set('BULL.HK', createRouteState('BULL.HK'));
    const firstPassEntered = createDeferred();
    const releaseFirstPass = createDeferred();
    const { marketDataClient } = createQuoteEmitter();
    const routeRuntime = createRouteRuntime({
      runtime,
      config: routeConfig,
      marketDataClient,
      processRoute: async () => {
        firstPassEntered.resolve();
        await releaseFirstPass.promise;
        throw new Error('route process failed once');
      },
    });

    routeRuntime.start();
    routeRuntime.triggerRoute('BULL.HK', 'ORDER_EVENT');
    await firstPassEntered.promise;

    const firstStopPromise = routeRuntime.stopAndDrain();
    releaseFirstPass.resolve();
    await expectPromiseRejectsToMatch(() => firstStopPromise, /route process failed once/);
    await routeRuntime.stopAndDrain();
  });

  it('in-flight 期间 ORDER_EVENT 后续收到 QUOTE 时补跑使用最新 QUOTE 唤醒原因', async () => {
    const runtime = createRuntimeStore();
    runtime.routeStatesBySymbol.set('BULL.HK', createRouteState('BULL.HK'));
    const firstPassEntered = createDeferred();
    const releaseFirstPass = createDeferred();
    const wakeupKinds: string[] = [];
    const { marketDataClient, emitQuote } = createQuoteEmitter();
    const routeRuntime = createRouteRuntime({
      runtime,
      config: routeConfig,
      marketDataClient,
      processRoute: async ({ wakeupKind }) => {
        wakeupKinds.push(wakeupKind);
        if (wakeupKinds.length === 1) {
          firstPassEntered.resolve();
          await releaseFirstPass.promise;
        }
      },
    });

    routeRuntime.start();
    routeRuntime.triggerRoute('BULL.HK', 'ORDER_EVENT');
    await firstPassEntered.promise;

    emitQuote({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', 1.06),
    });
    releaseFirstPass.resolve();
    await flushMicrotasks();

    expect(wakeupKinds).toEqual(['ORDER_EVENT', 'QUOTE']);
  });
});

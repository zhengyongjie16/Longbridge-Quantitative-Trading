/**
 * QuoteSubscriptionRuntime 业务测试
 *
 * 覆盖：首轮真相投影、seat 事件增量投影、临时 retain 的 admission 与释放。
 */
import { describe, expect, it } from 'bun:test';
import { createQuoteSubscriptionRuntime } from '../../../src/main/quoteSubscriptionRuntime/index.js';
import { createSymbolRegistry } from '../../../src/services/autoSymbolManager/utils.js';
import type { LastState } from '../../../src/types/state.js';
import type { OrderHoldSymbolsChangedEvent } from '../../../src/types/services.js';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';
import {
  createMonitorConfigDouble,
  createPositionCacheDouble,
  createPositionDouble,
} from '../../helpers/testDoubles.js';

function createLastState(): LastState {
  return {
    canTrade: true,
    isHalfDay: false,
    openProtectionActive: false,
    currentDayKey: '2026-04-10',
    lifecycleState: 'ACTIVE',
    pendingOpenRebuild: false,
    targetTradingDayKey: null,
    isTradingEnabled: true,
    cachedAccount: null,
    cachedPositions: [],
    positionCache: createPositionCacheDouble(),
    cachedTradingDayInfo: null,
    tradingCalendarSnapshot: new Map(),
    monitorStates: new Map(),
    allTradingSymbols: new Set(),
  };
}

function createOrderHoldEventSource(initialSymbols: ReadonlyArray<string>) {
  const holdSymbols = new Set(initialSymbols);
  const listeners = new Set<(event: OrderHoldSymbolsChangedEvent) => void>();

  return {
    trader: {
      getOrderHoldSymbols: () => new Set(holdSymbols),
      onOrderHoldSymbolsChanged: (listener: (event: OrderHoldSymbolsChangedEvent) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    add(symbol: string): void {
      holdSymbols.add(symbol);
      for (const listener of listeners) {
        listener({ symbol, action: 'ADDED' });
      }
    },
    remove(symbol: string): void {
      holdSymbols.delete(symbol);
      for (const listener of listeners) {
        listener({ symbol, action: 'REMOVED' });
      }
    },
  };
}

describe('QuoteSubscriptionRuntime', () => {
  it('reconcileFromCurrentTruth 投影 monitor、seat、position 与 order hold，并写入 committed set', async () => {
    const monitorConfig = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      longSymbol: 'BULL.HK',
      shortSymbol: 'BEAR.HK',
    });
    const symbolRegistry = createSymbolRegistry([monitorConfig]);
    const lastState = createLastState();
    lastState.cachedPositions = [
      createPositionDouble({ symbol: 'POS.HK', quantity: 100, availableQuantity: 100 }),
    ];
    const orderHoldEventSource = createOrderHoldEventSource(['ORDER.HK']);
    const subscribed: string[][] = [];
    const unsubscribed: string[][] = [];
    const runtime = createQuoteSubscriptionRuntime({
      tradingConfig: createTradingConfig({ monitors: [monitorConfig] }),
      symbolRegistry,
      marketDataClient: {
        subscribeSymbols: async (symbols) => {
          subscribed.push([...symbols]);
        },
        unsubscribeSymbols: async (symbols) => {
          unsubscribed.push([...symbols]);
        },
      },
      trader: orderHoldEventSource.trader,
      lastState,
    });

    await runtime.reconcileFromCurrentTruth();

    expect(new Set(subscribed.flat())).toEqual(
      new Set(['HSI.HK', 'BULL.HK', 'BEAR.HK', 'POS.HK', 'ORDER.HK']),
    );
    expect(unsubscribed).toEqual([]);
    expect(lastState.allTradingSymbols).toEqual(
      new Set(['HSI.HK', 'BULL.HK', 'BEAR.HK', 'POS.HK', 'ORDER.HK']),
    );
  });

  it('启动后按 order hold 事件动态增删订阅', async () => {
    const monitorConfig = createMonitorConfigDouble({ monitorSymbol: 'HSI.HK' });
    const symbolRegistry = createSymbolRegistry([monitorConfig]);
    const lastState = createLastState();
    const orderHoldEventSource = createOrderHoldEventSource([]);
    const subscribed: string[][] = [];
    const unsubscribed: string[][] = [];
    const runtime = createQuoteSubscriptionRuntime({
      tradingConfig: createTradingConfig({ monitors: [monitorConfig] }),
      symbolRegistry,
      marketDataClient: {
        subscribeSymbols: async (symbols) => {
          subscribed.push([...symbols]);
        },
        unsubscribeSymbols: async (symbols) => {
          unsubscribed.push([...symbols]);
        },
      },
      trader: orderHoldEventSource.trader,
      lastState,
    });

    await runtime.reconcileFromCurrentTruth();
    runtime.start();
    orderHoldEventSource.add('ORDER.HK');
    await runtime.waitForAdmission(['ORDER.HK']);

    expect(subscribed).toEqual([['HSI.HK', 'BULL.HK', 'BEAR.HK'], ['ORDER.HK']]);
    expect(lastState.allTradingSymbols.has('ORDER.HK')).toBe(true);

    orderHoldEventSource.remove('ORDER.HK');
    await runtime.waitForAdmission([]);

    expect(unsubscribed).toEqual([['ORDER.HK']]);
    expect(lastState.allTradingSymbols.has('ORDER.HK')).toBe(false);
    await runtime.stopAndDrain();
  });

  it('seat 事件只在 SEAT_BOUND 清空后退订对应交易标的', async () => {
    const monitorConfig = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      longSymbol: 'BULL.HK',
      shortSymbol: 'BEAR.HK',
    });
    const symbolRegistry = createSymbolRegistry([monitorConfig]);
    const lastState = createLastState();
    const orderHoldEventSource = createOrderHoldEventSource([]);
    const unsubscribed: string[][] = [];
    const runtime = createQuoteSubscriptionRuntime({
      tradingConfig: createTradingConfig({ monitors: [monitorConfig] }),
      symbolRegistry,
      marketDataClient: {
        subscribeSymbols: async () => {},
        unsubscribeSymbols: async (symbols) => {
          unsubscribed.push([...symbols]);
        },
      },
      trader: orderHoldEventSource.trader,
      lastState,
    });

    await runtime.reconcileFromCurrentTruth();
    runtime.start();
    symbolRegistry.updateSeatState(monitorConfig.monitorSymbol, 'LONG', {
      symbol: null,
      status: 'EMPTY',
      lastSwitchAt: Date.now(),
      lastSearchAt: Date.now(),
      lastSeatActivatedAt: null,
      callPrice: null,
      searchFailCountToday: 0,
      frozenTradingDayKey: null,
    });
    await runtime.waitForAdmission([]);

    expect(unsubscribed).toEqual([['BULL.HK']]);
    expect(lastState.allTradingSymbols.has('BULL.HK')).toBe(false);
    expect(lastState.allTradingSymbols.has('BEAR.HK')).toBe(true);
    await runtime.stopAndDrain();
  });

  it('临时 retain 完成 admission，释放后才允许退订', async () => {
    const monitorConfig = createMonitorConfigDouble({ monitorSymbol: 'HSI.HK' });
    const symbolRegistry = createSymbolRegistry([monitorConfig]);
    const lastState = createLastState();
    const orderHoldEventSource = createOrderHoldEventSource([]);
    const subscribed: string[][] = [];
    const unsubscribed: string[][] = [];
    const runtime = createQuoteSubscriptionRuntime({
      tradingConfig: createTradingConfig({ monitors: [monitorConfig] }),
      symbolRegistry,
      marketDataClient: {
        subscribeSymbols: async (symbols) => {
          subscribed.push([...symbols]);
        },
        unsubscribeSymbols: async (symbols) => {
          unsubscribed.push([...symbols]);
        },
      },
      trader: orderHoldEventSource.trader,
      lastState,
    });

    const release = await runtime.retainSymbols({
      ownerKey: 'HSI.HK:LONG:2',
      reason: 'SEAT_REFRESH_WAIT',
      symbols: ['NEXT.HK', 'PREV.HK'],
    });
    await runtime.waitForAdmission(['NEXT.HK', 'PREV.HK']);
    release();
    await runtime.waitForAdmission([]);

    expect(subscribed).toEqual([['NEXT.HK', 'PREV.HK']]);
    expect(unsubscribed).toEqual([['NEXT.HK', 'PREV.HK']]);
  });

  it('lifecycle 午夜重置后会按 lastState.allTradingSymbols 重新投影 committed truth', async () => {
    const monitorConfig = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      longSymbol: 'BULL.HK',
      shortSymbol: 'BEAR.HK',
    });
    const symbolRegistry = createSymbolRegistry([monitorConfig]);
    const lastState = createLastState();
    const orderHoldEventSource = createOrderHoldEventSource([]);
    const subscribed: string[][] = [];
    const runtime = createQuoteSubscriptionRuntime({
      tradingConfig: createTradingConfig({ monitors: [monitorConfig] }),
      symbolRegistry,
      marketDataClient: {
        subscribeSymbols: async (symbols) => {
          subscribed.push([...symbols]);
        },
        unsubscribeSymbols: async () => {},
      },
      trader: orderHoldEventSource.trader,
      lastState,
    });

    await runtime.reconcileFromCurrentTruth();
    await runtime.stopAndDrain();

    lastState.allTradingSymbols = new Set();
    await runtime.reconcileFromCurrentTruth();

    expect(subscribed).toEqual([
      ['HSI.HK', 'BULL.HK', 'BEAR.HK'],
      ['HSI.HK', 'BULL.HK', 'BEAR.HK'],
    ]);
    expect(lastState.allTradingSymbols).toEqual(new Set(['HSI.HK', 'BULL.HK', 'BEAR.HK']));
  });

  it('stopAndDrain 会退订当前 committed symbols 并清空 committed truth', async () => {
    const monitorConfig = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      longSymbol: 'BULL.HK',
      shortSymbol: 'BEAR.HK',
    });
    const symbolRegistry = createSymbolRegistry([monitorConfig]);
    const lastState = createLastState();
    const orderHoldEventSource = createOrderHoldEventSource([]);
    const subscribed: string[][] = [];
    const unsubscribed: string[][] = [];
    const runtime = createQuoteSubscriptionRuntime({
      tradingConfig: createTradingConfig({ monitors: [monitorConfig] }),
      symbolRegistry,
      marketDataClient: {
        subscribeSymbols: async (symbols) => {
          subscribed.push([...symbols]);
        },
        unsubscribeSymbols: async (symbols) => {
          unsubscribed.push([...symbols]);
        },
      },
      trader: orderHoldEventSource.trader,
      lastState,
    });

    await runtime.reconcileFromCurrentTruth();
    await runtime.stopAndDrain();

    expect(subscribed).toEqual([['HSI.HK', 'BULL.HK', 'BEAR.HK']]);
    expect(unsubscribed).toEqual([['HSI.HK', 'BULL.HK', 'BEAR.HK']]);
    expect(lastState.allTradingSymbols).toEqual(new Set());
  });

  it('startup 已手工接入的订阅集合不会被 committed truth 重复订阅', async () => {
    const monitorConfig = createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      longSymbol: 'BULL.HK',
      shortSymbol: 'BEAR.HK',
    });
    const symbolRegistry = createSymbolRegistry([monitorConfig]);
    const lastState = createLastState();
    lastState.allTradingSymbols = new Set(['HSI.HK', 'BULL.HK', 'BEAR.HK']);
    const orderHoldEventSource = createOrderHoldEventSource([]);
    const subscribed: string[][] = [];
    const unsubscribed: string[][] = [];
    const runtime = createQuoteSubscriptionRuntime({
      tradingConfig: createTradingConfig({ monitors: [monitorConfig] }),
      symbolRegistry,
      marketDataClient: {
        subscribeSymbols: async (symbols) => {
          subscribed.push([...symbols]);
        },
        unsubscribeSymbols: async (symbols) => {
          unsubscribed.push([...symbols]);
        },
      },
      trader: orderHoldEventSource.trader,
      lastState,
    });

    await runtime.reconcileFromCurrentTruth();

    expect(subscribed).toEqual([]);
    expect(unsubscribed).toEqual([]);
    expect(lastState.allTradingSymbols).toEqual(new Set(['HSI.HK', 'BULL.HK', 'BEAR.HK']));
  });
});

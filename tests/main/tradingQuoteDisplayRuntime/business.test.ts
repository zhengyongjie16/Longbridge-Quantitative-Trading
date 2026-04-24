/**
 * tradingQuoteDisplayRuntime 业务测试
 *
 * 功能：
 * - 验证交易标的 quote 事件按单标的输出
 * - 验证异步补充 monitor quote 后会复核 seatVersion，旧 route 不输出
 */
import { describe, expect, it, mock } from 'bun:test';
import {
  createMonitorContextDouble,
  createQuoteDouble,
  createSymbolRegistryDouble,
} from '../../helpers/testDoubles.js';
import type { QuoteUpdatedEvent } from '../../../src/types/services.js';

const warnLogs: string[] = [];

mock.module('../../../src/utils/logger/index.js', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: (message: string) => {
      warnLogs.push(message);
    },
    error: () => {},
  },
}));

function waitTick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('tradingQuoteDisplayRuntime', () => {
  it('renders only the matched trading symbol event', async () => {
    warnLogs.length = 0;
    const { createTradingQuoteDisplayRuntime } =
      await import('../../../src/main/tradingQuoteDisplayRuntime/index.js');
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: 'BEAR.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });
    let quoteUpdatedListener: ((event: QuoteUpdatedEvent) => void) | undefined;
    const renders: string[] = [];
    const runtime = createTradingQuoteDisplayRuntime({
      marketDataClient: {
        onQuoteUpdated: (listener: (event: QuoteUpdatedEvent) => void) => {
          quoteUpdatedListener = listener;
          return () => {
            if (quoteUpdatedListener === listener) {
              quoteUpdatedListener = undefined;
            }
          };
        },
        getQuotes: async () => new Map([['HSI.HK', createQuoteDouble('HSI.HK', 20_000)]]),
      },
      symbolRegistry,
      monitorContexts: new Map([['HSI.HK', createMonitorContextDouble({ symbolRegistry })]]),
      lastState: {
        isTradingEnabled: true,
        canTrade: true,
      },
      renderTradingQuote: (params: { readonly tradingSymbol: string }) => {
        renders.push(params.tradingSymbol);
      },
    });

    runtime.start();
    quoteUpdatedListener?.({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', 1.01),
    });
    await waitTick();

    expect(renders).toEqual(['BULL.HK']);
    await runtime.stopAndDrain();
  });

  it('skips render when seatVersion changes before async quote supplement completes', async () => {
    warnLogs.length = 0;
    const { createTradingQuoteDisplayRuntime } =
      await import('../../../src/main/tradingQuoteDisplayRuntime/index.js');
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: 'BEAR.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });
    let quoteUpdatedListener: ((event: QuoteUpdatedEvent) => void) | undefined;
    let resolveQuotes: (() => void) | undefined;
    const quoteBlocked = new Promise<void>((resolve) => {
      resolveQuotes = resolve;
    });
    const renders: string[] = [];
    const runtime = createTradingQuoteDisplayRuntime({
      marketDataClient: {
        onQuoteUpdated: (listener: (event: QuoteUpdatedEvent) => void) => {
          quoteUpdatedListener = listener;
          return () => {
            if (quoteUpdatedListener === listener) {
              quoteUpdatedListener = undefined;
            }
          };
        },
        getQuotes: async () => {
          await quoteBlocked;
          return new Map([['HSI.HK', createQuoteDouble('HSI.HK', 20_000)]]);
        },
      },
      symbolRegistry,
      monitorContexts: new Map([['HSI.HK', createMonitorContextDouble({ symbolRegistry })]]),
      lastState: {
        isTradingEnabled: true,
        canTrade: true,
      },
      renderTradingQuote: (params: { readonly tradingSymbol: string }) => {
        renders.push(params.tradingSymbol);
      },
    });

    runtime.start();
    quoteUpdatedListener?.({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', 1.01),
    });
    symbolRegistry.bumpSeatVersion('HSI.HK', 'LONG');
    resolveQuotes?.();
    await waitTick();
    await waitTick();

    expect(renders).toEqual([]);
    await runtime.stopAndDrain();
  });

  it('logs and skips when quote supplement fails, then continues rendering later events', async () => {
    const { createTradingQuoteDisplayRuntime } =
      await import('../../../src/main/tradingQuoteDisplayRuntime/index.js');
    warnLogs.length = 0;
    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: 'HSI.HK',
      longSeat: {
        symbol: 'BULL.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: 'BEAR.HK',
        status: 'ACTIVE',
        lastSwitchAt: null,
        lastSearchAt: null,
        lastSeatActivatedAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
    });
    let quoteUpdatedListener: ((event: QuoteUpdatedEvent) => void) | undefined;
    let shouldFail = true;
    const renders: string[] = [];
    const runtime = createTradingQuoteDisplayRuntime({
      marketDataClient: {
        onQuoteUpdated: (listener: (event: QuoteUpdatedEvent) => void) => {
          quoteUpdatedListener = listener;
          return () => {
            if (quoteUpdatedListener === listener) {
              quoteUpdatedListener = undefined;
            }
          };
        },
        getQuotes: async () => {
          if (shouldFail) {
            shouldFail = false;
            throw new Error('quote supplement failed');
          }

          return new Map([['HSI.HK', createQuoteDouble('HSI.HK', 20_000)]]);
        },
      },
      symbolRegistry,
      monitorContexts: new Map([['HSI.HK', createMonitorContextDouble({ symbolRegistry })]]),
      lastState: {
        isTradingEnabled: true,
        canTrade: true,
      },
      renderTradingQuote: (params: { readonly tradingSymbol: string }) => {
        renders.push(params.tradingSymbol);
      },
    });

    runtime.start();
    quoteUpdatedListener?.({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', 1.01),
    });
    await waitTick();
    await waitTick();

    quoteUpdatedListener?.({
      symbol: 'BULL.HK',
      quote: createQuoteDouble('BULL.HK', 1.02),
    });
    await waitTick();
    await waitTick();

    expect(warnLogs).toHaveLength(1);
    expect(renders).toEqual(['BULL.HK']);
    await runtime.stopAndDrain();
  });
});

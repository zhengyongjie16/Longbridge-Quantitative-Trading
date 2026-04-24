/**
 * monitorDisplayRuntime 业务测试
 *
 * 功能：
 * - 验证 monitor display runtime 在门禁打开时按请求渲染监控标的
 * - 验证同一 monitorSymbol 的 latest-only collapse 只渲染最新快照
 */
import { describe, expect, it, mock } from 'bun:test';
import type { IndicatorSnapshot } from '../../../src/types/quote.js';
import { createMonitorContextDouble, createQuoteDouble } from '../../helpers/testDoubles.js';

const infoLogs: string[] = [];
const warnLogs: string[] = [];

mock.module('../../../src/utils/logger/index.js', () => ({
  logger: {
    debug: () => {},
    info: (message: string) => {
      infoLogs.push(message);
    },
    warn: (message: string) => {
      warnLogs.push(message);
    },
    error: () => {},
  },
}));

function createSnapshot(price: number): IndicatorSnapshot {
  return {
    price,
    changePercent: 0,
    ema: { 7: price - 1 },
    rsi: { 6: 52 },
    psy: { 13: 58 },
    mfi: 45,
    kdj: { k: 51, d: 49, j: 55 },
    macd: { macd: 10, dif: 3, dea: 2 },
    adx: null,
  };
}

function waitTick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('monitorDisplayRuntime', () => {
  it('renders latest monitor snapshot with current monitor quote', async () => {
    infoLogs.length = 0;
    warnLogs.length = 0;
    const { createMonitorDisplayRuntime } =
      await import('../../../src/main/monitorDisplayRuntime/index.js');
    const runtime = createMonitorDisplayRuntime({
      marketDataClient: {
        getQuotes: async () => new Map([['HSI.HK', createQuoteDouble('HSI.HK', 20_010)]]),
        getCandlestickSnapshot: () => ({
          symbol: 'HSI.HK',
          period: 0 as never,
          version: 1,
          candles: [],
          lastBarTimestamp: 1_708_000_000_000,
          lastBarConfirmed: true,
          initialized: true,
        }),
      },
      monitorContexts: new Map([['HSI.HK', createMonitorContextDouble()]]),
      lastState: {
        isTradingEnabled: true,
        canTrade: true,
      },
      marketMonitor: {
        renderMonitorIndicators: (params: {
          readonly monitorSymbol: string;
          readonly monitorSnapshot: IndicatorSnapshot;
        }) => {
          infoLogs.push(`render:${params.monitorSymbol}:${params.monitorSnapshot.price}`);
        },
      },
    });

    runtime.start();
    runtime.requestRender({
      monitorSymbol: 'HSI.HK',
      monitorSnapshot: createSnapshot(20_000),
    });
    await waitTick();

    expect(infoLogs).toContain('render:HSI.HK:20000');
    await runtime.stopAndDrain();
  });

  it('collapses concurrent requests for the same monitor to the latest snapshot', async () => {
    infoLogs.length = 0;
    warnLogs.length = 0;
    const { createMonitorDisplayRuntime } =
      await import('../../../src/main/monitorDisplayRuntime/index.js');
    let resolveQuotes: (() => void) | undefined;
    const quoteBlocked = new Promise<void>((resolve) => {
      resolveQuotes = resolve;
    });
    const runtime = createMonitorDisplayRuntime({
      marketDataClient: {
        getQuotes: async () => {
          await quoteBlocked;
          return new Map([['HSI.HK', createQuoteDouble('HSI.HK', 20_020)]]);
        },
        getCandlestickSnapshot: () => ({
          symbol: 'HSI.HK',
          period: 0 as never,
          version: 1,
          candles: [],
          lastBarTimestamp: 1_708_000_000_000,
          lastBarConfirmed: true,
          initialized: true,
        }),
      },
      monitorContexts: new Map([['HSI.HK', createMonitorContextDouble()]]),
      lastState: {
        isTradingEnabled: true,
        canTrade: true,
      },
      marketMonitor: {
        renderMonitorIndicators: (params: {
          readonly monitorSymbol: string;
          readonly monitorSnapshot: IndicatorSnapshot;
        }) => {
          infoLogs.push(`render:${params.monitorSymbol}:${params.monitorSnapshot.price}`);
        },
      },
    });

    runtime.start();
    runtime.requestRender({
      monitorSymbol: 'HSI.HK',
      monitorSnapshot: createSnapshot(20_000),
    });

    runtime.requestRender({
      monitorSymbol: 'HSI.HK',
      monitorSnapshot: createSnapshot(20_100),
    });
    resolveQuotes?.();
    await waitTick();
    await waitTick();

    expect(infoLogs).toEqual(['render:HSI.HK:20100']);
    await runtime.stopAndDrain();
  });

  it('logs and skips when quote fetch fails, then continues rendering later requests', async () => {
    infoLogs.length = 0;
    warnLogs.length = 0;
    const { createMonitorDisplayRuntime } =
      await import('../../../src/main/monitorDisplayRuntime/index.js');
    let shouldFail = true;
    const runtime = createMonitorDisplayRuntime({
      marketDataClient: {
        getQuotes: async () => {
          if (shouldFail) {
            shouldFail = false;
            throw new Error('quote fetch failed');
          }

          return new Map([['HSI.HK', createQuoteDouble('HSI.HK', 20_030)]]);
        },
        getCandlestickSnapshot: () => ({
          symbol: 'HSI.HK',
          period: 0 as never,
          version: 1,
          candles: [],
          lastBarTimestamp: 1_708_000_000_000,
          lastBarConfirmed: true,
          initialized: true,
        }),
      },
      monitorContexts: new Map([['HSI.HK', createMonitorContextDouble()]]),
      lastState: {
        isTradingEnabled: true,
        canTrade: true,
      },
      marketMonitor: {
        renderMonitorIndicators: (params: {
          readonly monitorSymbol: string;
          readonly monitorSnapshot: IndicatorSnapshot;
        }) => {
          infoLogs.push(`render:${params.monitorSymbol}:${params.monitorSnapshot.price}`);
        },
      },
    });

    runtime.start();
    runtime.requestRender({
      monitorSymbol: 'HSI.HK',
      monitorSnapshot: createSnapshot(20_000),
    });
    await waitTick();
    await waitTick();

    runtime.requestRender({
      monitorSymbol: 'HSI.HK',
      monitorSnapshot: createSnapshot(20_100),
    });
    await waitTick();
    await waitTick();

    expect(warnLogs).toHaveLength(1);
    expect(infoLogs).toContain('render:HSI.HK:20100');
    await runtime.stopAndDrain();
  });
});

import { describe, expect, it } from 'bun:test';

import { createMarketMonitor } from '../../../src/services/marketMonitor/index.js';
import type { IndicatorSnapshot } from '../../../src/types/quote.js';
import type { MonitorState } from '../../../src/types/state.js';
import { createQuoteDouble } from '../../helpers/testDoubles.js';

function createMonitorState(monitorSymbol: string): MonitorState {
  return {
    monitorSymbol,
    monitorPrice: null,
    longPrice: null,
    shortPrice: null,
    signal: null,
    pendingDelayedSignals: [],
    monitorValues: null,
    lastMonitorSnapshot: null,
    lastCandleFingerprint: null,
  };
}

function createSnapshot(overrides: Partial<IndicatorSnapshot> = {}): IndicatorSnapshot {
  return {
    price: 20_000,
    changePercent: 0,
    ema: { 7: 19_980 },
    rsi: { 6: 52 },
    psy: { 13: 58 },
    mfi: 45,
    kdj: { k: 51, d: 49, j: 55 },
    macd: { macd: 10, dif: 3, dea: 2 },
    ...overrides,
  };
}

describe('marketMonitor business flow', () => {
  it('detects price change with configured threshold and updates state', () => {
    const monitor = createMarketMonitor();
    const state = createMonitorState('HSI.HK');

    const firstChanged = monitor.monitorPriceChanges(
      createQuoteDouble('LONG.HK', 1),
      createQuoteDouble('SHORT.HK', 2),
      'LONG.HK',
      'SHORT.HK',
      state,
    );
    expect(firstChanged).toBe(true);
    expect(state.longPrice).toBe(1);
    expect(state.shortPrice).toBe(2);

    const belowThresholdChanged = monitor.monitorPriceChanges(
      createQuoteDouble('LONG.HK', 1.0005),
      createQuoteDouble('SHORT.HK', 2.0004),
      'LONG.HK',
      'SHORT.HK',
      state,
    );
    expect(belowThresholdChanged).toBe(false);

    const aboveThresholdChanged = monitor.monitorPriceChanges(
      createQuoteDouble('LONG.HK', 1.01),
      createQuoteDouble('SHORT.HK', 2),
      'LONG.HK',
      'SHORT.HK',
      state,
    );
    expect(aboveThresholdChanged).toBe(true);
    expect(state.longPrice).toBe(1.01);
  });

  it('detects indicator changes and keeps monitorValues in sync', () => {
    const monitor = createMarketMonitor();
    const state = createMonitorState('HSI.HK');
    const monitorQuote = createQuoteDouble('HSI.HK', 20_000);

    const first = monitor.monitorIndicatorChanges(
      createSnapshot(),
      monitorQuote,
      'HSI.HK',
      [7],
      [6],
      [13],
      state,
    );
    expect(first).toBe(true);
    expect(state.monitorValues?.price).toBe(20_000);
    expect(state.monitorValues?.ema?.[7]).toBe(19_980);

    const unchanged = monitor.monitorIndicatorChanges(
      createSnapshot(),
      monitorQuote,
      'HSI.HK',
      [7],
      [6],
      [13],
      state,
    );
    expect(unchanged).toBe(false);

    const changed = monitor.monitorIndicatorChanges(
      createSnapshot({
        macd: { macd: 12, dif: 4, dea: 2.2 },
      }),
      monitorQuote,
      'HSI.HK',
      [7],
      [6],
      [13],
      state,
    );
    expect(changed).toBe(true);
    expect(state.monitorValues?.macd?.macd).toBe(12);
  });
});

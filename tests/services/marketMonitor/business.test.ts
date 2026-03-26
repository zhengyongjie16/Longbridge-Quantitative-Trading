/**
 * marketMonitor 业务测试
 *
 * 功能：
 * - 验证市场监控相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';

import { createMarketMonitor } from '../../../src/services/marketMonitor/index.js';
import {
  formatPositionDisplay,
  formatWarrantDistanceDisplay,
} from '../../../src/services/marketMonitor/utils.js';
import type { IndicatorSnapshot } from '../../../src/types/quote.js';
import type { MonitorState } from '../../../src/types/state.js';
import {
  createIndicatorUsageProfileDouble,
  createQuoteDouble,
  createWarrantDistanceInfoDouble,
} from '../../helpers/testDoubles.js';

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
    lastCandlestickCacheVersion: null,
    incrementalIndicatorRuntime: null,
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
    adx: null,
    ...overrides,
  };
}

describe('marketMonitor business flow', () => {
  it('formats warrant distance display with unified label', () => {
    expect(formatWarrantDistanceDisplay(null)).toBeNull();

    const bullText = formatWarrantDistanceDisplay(
      createWarrantDistanceInfoDouble({
        warrantType: 'BULL',
        distanceToStrikePercent: 1.9,
      }),
    );
    expect(bullText).toBe('距回收价=+1.90%');

    const bearText = formatWarrantDistanceDisplay(
      createWarrantDistanceInfoDouble({
        warrantType: 'BEAR',
        distanceToStrikePercent: -2.35,
      }),
    );
    expect(bearText).toBe('距回收价=-2.35%');

    const unknownText = formatWarrantDistanceDisplay(
      createWarrantDistanceInfoDouble({
        warrantType: 'BULL',
        distanceToStrikePercent: null,
      }),
    );
    expect(unknownText).toBe('距回收价=未知');
  });

  it('formats position display text with required labels and order', () => {
    const display = formatPositionDisplay(
      {
        r1: 100,
        n1: 100,
        r2: 110,
        unrealizedPnL: 10,
      },
      2,
    );
    expect(display).toBe('持仓市值=110.00 持仓盈亏=+10.00 订单数量=2');

    const emptyDisplay = formatPositionDisplay(null, null);
    expect(emptyDisplay).toBe('持仓市值=- 持仓盈亏=- 订单数量=-');
  });

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
    const klineTimestamp = 1_708_000_000_000;
    const indicatorProfile = createIndicatorUsageProfileDouble();

    const first = monitor.monitorIndicatorChanges({
      monitorSnapshot: createSnapshot(),
      monitorQuote,
      monitorSymbol: 'HSI.HK',
      indicatorProfile,
      klineTimestamp,
      monitorState: state,
    });
    expect(first).toBe(true);
    expect(state.monitorValues?.price).toBe(20_000);
    expect(state.monitorValues?.ema?.[7]).toBe(19_980);

    const unchanged = monitor.monitorIndicatorChanges({
      monitorSnapshot: createSnapshot(),
      monitorQuote,
      monitorSymbol: 'HSI.HK',
      indicatorProfile,
      klineTimestamp,
      monitorState: state,
    });
    expect(unchanged).toBe(false);

    const changed = monitor.monitorIndicatorChanges({
      monitorSnapshot: createSnapshot({
        macd: { macd: 12, dif: 4, dea: 2.2 },
      }),
      monitorQuote,
      monitorSymbol: 'HSI.HK',
      indicatorProfile,
      klineTimestamp,
      monitorState: state,
    });
    expect(changed).toBe(true);
    expect(state.monitorValues?.macd?.macd).toBe(12);
  });

  it('detects ADX change and writes adx to monitorValues', () => {
    const monitor = createMarketMonitor();
    const state = createMonitorState('HSI.HK');
    const monitorQuote = createQuoteDouble('HSI.HK', 20_000);
    const klineTimestamp = 1_708_000_000_000;
    const indicatorProfile = createIndicatorUsageProfileDouble();

    // 首次写入
    monitor.monitorIndicatorChanges({
      monitorSnapshot: createSnapshot({ adx: 25 }),
      monitorQuote,
      monitorSymbol: 'HSI.HK',
      indicatorProfile,
      klineTimestamp,
      monitorState: state,
    });
    expect(state.monitorValues?.adx).toBe(25);

    // ADX 变化触发更新
    const changed = monitor.monitorIndicatorChanges({
      monitorSnapshot: createSnapshot({ adx: 30 }),
      monitorQuote,
      monitorSymbol: 'HSI.HK',
      indicatorProfile,
      klineTimestamp,
      monitorState: state,
    });
    expect(changed).toBe(true);
    expect(state.monitorValues?.adx).toBe(30);
  });

  it('stores only displayPlan fields in monitorValues cache', () => {
    const monitor = createMarketMonitor();
    const state = createMonitorState('HSI.HK');
    const monitorQuote = createQuoteDouble('HSI.HK', 20_000);
    const klineTimestamp = 1_708_000_000_000;
    const indicatorProfile = createIndicatorUsageProfileDouble({
      displayPlan: ['price', 'changePercent', 'EMA:7', 'K', 'ADX'],
    });

    const changed = monitor.monitorIndicatorChanges({
      monitorSnapshot: createSnapshot({ adx: 25 }),
      monitorQuote,
      monitorSymbol: 'HSI.HK',
      indicatorProfile,
      klineTimestamp,
      monitorState: state,
    });

    expect(changed).toBe(true);
    expect(state.monitorValues?.price).toBe(20_000);
    expect(state.monitorValues?.changePercent).toBe(0);
    expect(state.monitorValues?.ema?.[7]).toBe(19_980);
    expect(state.monitorValues?.kdj).toEqual({ k: 51, d: 49, j: 55 });
    expect(state.monitorValues?.adx).toBe(25);
    expect(state.monitorValues?.rsi).toBeNull();
    expect(state.monitorValues?.psy).toBeNull();
    expect(state.monitorValues?.mfi).toBeNull();
    expect(state.monitorValues?.macd).toBeNull();
  });

  it('ignores indicator changes outside displayPlan when detecting monitor updates', () => {
    const monitor = createMarketMonitor();
    const state = createMonitorState('HSI.HK');
    const monitorQuote = createQuoteDouble('HSI.HK', 20_000);
    const klineTimestamp = 1_708_000_000_000;
    const indicatorProfile = createIndicatorUsageProfileDouble({
      displayPlan: ['price', 'EMA:7', 'K'],
    });

    const first = monitor.monitorIndicatorChanges({
      monitorSnapshot: createSnapshot(),
      monitorQuote,
      monitorSymbol: 'HSI.HK',
      indicatorProfile,
      klineTimestamp,
      monitorState: state,
    });
    expect(first).toBe(true);

    const unchanged = monitor.monitorIndicatorChanges({
      monitorSnapshot: createSnapshot({
        rsi: { 6: 80 },
        macd: { macd: 12, dif: 4, dea: 2.2 },
        adx: 35,
        mfi: 10,
        psy: { 13: 30 },
      }),
      monitorQuote,
      monitorSymbol: 'HSI.HK',
      indicatorProfile,
      klineTimestamp,
      monitorState: state,
    });

    expect(unchanged).toBe(false);
    expect(state.monitorValues?.ema?.[7]).toBe(19_980);
    expect(state.monitorValues?.kdj?.k).toBe(51);
    expect(state.monitorValues?.rsi).toBeNull();
    expect(state.monitorValues?.macd).toBeNull();
    expect(state.monitorValues?.adx).toBeNull();
  });

  it('does not trigger update when only D/J change under displayPlan: [K]', () => {
    const monitor = createMarketMonitor();
    const state = createMonitorState('HSI.HK');
    const monitorQuote = createQuoteDouble('HSI.HK', 20_000);
    const klineTimestamp = 1_708_000_000_000;
    const indicatorProfile = createIndicatorUsageProfileDouble({
      displayPlan: ['K'],
    });

    const first = monitor.monitorIndicatorChanges({
      monitorSnapshot: createSnapshot({ kdj: { k: 51, d: 49, j: 55 } }),
      monitorQuote,
      monitorSymbol: 'HSI.HK',
      indicatorProfile,
      klineTimestamp,
      monitorState: state,
    });
    expect(first).toBe(true);

    // 仅 D/J 变化，K 不变——displayPlan 只含 'K'，不应触发更新
    const unchanged = monitor.monitorIndicatorChanges({
      monitorSnapshot: createSnapshot({ kdj: { k: 51, d: 30, j: 83 } }),
      monitorQuote,
      monitorSymbol: 'HSI.HK',
      indicatorProfile,
      klineTimestamp,
      monitorState: state,
    });
    expect(unchanged).toBe(false);
  });

  it('does not trigger update when only non-MACD indicators change under displayPlan: [MACD]', () => {
    const monitor = createMarketMonitor();
    const state = createMonitorState('HSI.HK');
    const monitorQuote = createQuoteDouble('HSI.HK', 20_000);
    const klineTimestamp = 1_708_000_000_000;
    const indicatorProfile = createIndicatorUsageProfileDouble({
      displayPlan: ['MACD'],
    });

    const first = monitor.monitorIndicatorChanges({
      monitorSnapshot: createSnapshot({ macd: { macd: 10, dif: 3, dea: 2 } }),
      monitorQuote,
      monitorSymbol: 'HSI.HK',
      indicatorProfile,
      klineTimestamp,
      monitorState: state,
    });
    expect(first).toBe(true);

    // RSI / ADX / KDJ 全部变化，MACD 本身不变——displayPlan 只含 'MACD'，不应触发更新
    const unchanged = monitor.monitorIndicatorChanges({
      monitorSnapshot: createSnapshot({
        macd: { macd: 10, dif: 3, dea: 2 },
        rsi: { 6: 90 },
        adx: 70,
        kdj: { k: 10, d: 10, j: 10 },
      }),
      monitorQuote,
      monitorSymbol: 'HSI.HK',
      indicatorProfile,
      klineTimestamp,
      monitorState: state,
    });
    expect(unchanged).toBe(false);
  });
});

/**
 * marketMonitor 业务测试
 *
 * 功能：
 * - 验证纯渲染器输出格式相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it, mock } from 'bun:test';

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

import { createMarketMonitor } from '../../../src/services/marketMonitor/index.js';
import {
  formatPositionDisplay,
  formatWarrantDistanceDisplay,
} from '../../../src/services/marketMonitor/utils.js';
import type { IndicatorSnapshot } from '../../../src/types/quote.js';
import {
  createIndicatorUsageProfileDouble,
  createQuoteDouble,
  createWarrantDistanceInfoDouble,
} from '../../helpers/testDoubles.js';

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

describe('marketMonitor renderer', () => {
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

  it('renders monitor indicators directly without local change detection state', () => {
    infoLogs.length = 0;
    warnLogs.length = 0;
    const monitor = createMarketMonitor();

    monitor.renderMonitorIndicators({
      monitorSnapshot: createSnapshot(),
      monitorQuote: createQuoteDouble('HSI.HK', 20_000),
      monitorSymbol: 'HSI.HK',
      indicatorProfile: createIndicatorUsageProfileDouble({
        displayPlan: ['price', 'changePercent', 'EMA:7', 'K', 'MACD'],
      }),
      klineTimestamp: 1_708_000_000_000,
    });

    expect(infoLogs).toHaveLength(1);
    expect(infoLogs[0]).toContain('[监控标的]');
    expect(infoLogs[0]).toContain('HSI.HK');
    expect(infoLogs[0]).toContain('价格=20000.000');
    expect(infoLogs[0]).toContain('EMA7=19980.000');
    expect(infoLogs[0]).toContain('K=51.000');
    expect(infoLogs[0]).toContain('MACD=10.000');
  });

  it('renders single trading quote directly without dual-side coupling', () => {
    infoLogs.length = 0;
    warnLogs.length = 0;
    const monitor = createMarketMonitor();

    monitor.renderTradingQuote({
      event: {
        symbol: 'BULL.HK',
        quote: createQuoteDouble('BULL.HK', 1.23),
      },
      tradingSymbol: 'BULL.HK',
      monitorSymbol: 'HSI.HK',
      direction: 'LONG',
      monitorQuote: createQuoteDouble('HSI.HK', 20_000),
      displayInfo: {
        warrantDistanceInfo: createWarrantDistanceInfoDouble({
          warrantType: 'BULL',
          distanceToStrikePercent: 0.7,
        }),
        unrealizedLossMetrics: {
          r1: 100,
          n1: 100,
          r2: 110,
          unrealizedPnL: 10,
        },
        orderCount: 2,
      },
    });

    expect(infoLogs).toHaveLength(1);
    expect(infoLogs[0]).toContain('[做多标的]');
    expect(infoLogs[0]).toContain('BULL.HK');
    expect(infoLogs[0]).toContain('距回收价=+0.70%');
    expect(infoLogs[0]).toContain('持仓市值=110.00 持仓盈亏=+10.00 订单数量=2');
  });

  it('warns when trading quote is unavailable', () => {
    infoLogs.length = 0;
    warnLogs.length = 0;
    const monitor = createMarketMonitor();

    monitor.renderTradingQuote({
      event: {
        symbol: 'BULL.HK',
        quote: createQuoteDouble('BULL.HK', 1.23),
      },
      tradingSymbol: 'OTHER.HK',
      monitorSymbol: 'HSI.HK',
      direction: 'LONG',
      monitorQuote: createQuoteDouble('HSI.HK', 20_000),
      displayInfo: null,
    });

    expect(infoLogs).toEqual([]);
    expect(warnLogs).toEqual(['未获取到做多标的行情。']);
  });
});

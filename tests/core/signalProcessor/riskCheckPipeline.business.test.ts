import { beforeEach, describe, expect, it } from 'bun:test';
import type { RiskCheckContext } from '../../../src/types/services.js';
import { createRiskCheckPipeline } from '../../../src/core/signalProcessor/riskCheckPipeline.js';
import { createLiquidationCooldownTrackerDouble, createMonitorConfigDouble ,
  createAccountSnapshotDouble,
  createDoomsdayProtectionDouble,
  createOrderRecorderDouble,
  createPositionCacheDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createSignalDouble,
  createTraderDouble,
} from '../../helpers/testDoubles.js';
import { createTradingConfig } from '../../../mock/factories/configFactory.js';

function withMockedNow<T>(nowMs: number, run: () => Promise<T>): Promise<T> {
  const originalNow = Date.now;
  Date.now = () => nowMs;
  return run().finally(() => {
    Date.now = originalNow;
  });
}

function createContext(params: {
  readonly trader: ReturnType<typeof createTraderDouble>;
  readonly riskChecker: ReturnType<typeof createRiskCheckerDouble>;
  readonly orderRecorder: ReturnType<typeof createOrderRecorderDouble>;
  readonly longSymbol?: string;
  readonly shortSymbol?: string;
}): RiskCheckContext {
  const monitorConfig = createMonitorConfigDouble();
  const longSymbol = params.longSymbol ?? 'BULL.HK';
  const shortSymbol = params.shortSymbol ?? 'BEAR.HK';

  return {
    trader: params.trader,
    riskChecker: params.riskChecker,
    orderRecorder: params.orderRecorder,
    longQuote: createQuoteDouble(longSymbol, 10),
    shortQuote: createQuoteDouble(shortSymbol, 10),
    monitorQuote: createQuoteDouble('HSI.HK', 20000),
    monitorSnapshot: {
      price: 20000,
      changePercent: 0,
      ema: null,
      rsi: null,
      psy: null,
      mfi: null,
      kdj: { k: 50, d: 50, j: 50 },
      macd: { macd: 0, dif: 0, dea: 0 },
    },
    longSymbol,
    shortSymbol,
    longSymbolName: longSymbol,
    shortSymbolName: shortSymbol,
    account: createAccountSnapshotDouble(100000),
    positions: [],
    lastState: {
      cachedAccount: createAccountSnapshotDouble(100000),
      cachedPositions: [],
      positionCache: createPositionCacheDouble([]),
    },
    currentTime: new Date('2026-02-16T10:00:00+08:00'),
    isHalfDay: false,
    doomsdayProtection: createDoomsdayProtectionDouble(),
    config: monitorConfig,
  };
}

describe('riskCheckPipeline business flow', () => {
  let lastRiskCheckTime: Map<string, number>;

  beforeEach(() => {
    lastRiskCheckTime = new Map();
  });

  it('pre-cooldown filtering blocks signal before any buy API call', async () => {
    const trader = createTraderDouble({
      getAccountSnapshot: async () => {
        throw new Error('should not request account in cooldown path');
      },
      getStockPositions: async () => {
        throw new Error('should not request positions in cooldown path');
      },
    });
    const riskChecker = createRiskCheckerDouble();
    const orderRecorder = createOrderRecorderDouble();

    const pipeline = createRiskCheckPipeline({
      tradingConfig: createTradingConfig(),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
      lastRiskCheckTime,
    });

    const signal = createSignalDouble('BUYCALL', 'BULL.HK');
    lastRiskCheckTime.set('BULL.HK_BUY', 10_000);

    const result = await withMockedNow(10_500, async () =>
      pipeline([signal], createContext({ trader, riskChecker, orderRecorder })),
    );

    expect(result).toHaveLength(0);
    expect(signal.reason).toContain('风险检查冷却期内');
  });

  it('executes buy checks in business order and marks buy attempt before heavy checks', async () => {
    const steps: string[] = [];
    const trader = createTraderDouble({
      getAccountSnapshot: async () => {
        steps.push('getAccountSnapshot');
        return createAccountSnapshotDouble(100000);
      },
      getStockPositions: async () => {
        steps.push('getStockPositions');
        return [];
      },
      _canTradeNow: () => {
        steps.push('_canTradeNow');
        return { canTrade: true };
      },
      _markBuyAttempt: () => {
        steps.push('_markBuyAttempt');
      },
    });
    const riskChecker = createRiskCheckerDouble({
      checkWarrantRisk: () => {
        steps.push('checkWarrantRisk');
        return { allowed: true };
      },
      checkBeforeOrder: () => {
        steps.push('checkBeforeOrder');
        return { allowed: true };
      },
    });
    const orderRecorder = createOrderRecorderDouble({
      getLatestBuyOrderPrice: () => null,
    });

    const cooldownTracker = createLiquidationCooldownTrackerDouble({
      getRemainingMs: () => {
        steps.push('getRemainingMs');
        return 0;
      },
    });

    const pipeline = createRiskCheckPipeline({
      tradingConfig: createTradingConfig(),
      liquidationCooldownTracker: cooldownTracker,
      lastRiskCheckTime,
    });

    const signal = createSignalDouble('BUYCALL', 'BULL.HK');
    const result = await withMockedNow(30_000, async () =>
      pipeline([signal], createContext({ trader, riskChecker, orderRecorder })),
    );

    expect(result).toHaveLength(1);
    const markIndex = steps.indexOf('_markBuyAttempt');
    const warrantIndex = steps.indexOf('checkWarrantRisk');
    const baseRiskIndex = steps.indexOf('checkBeforeOrder');
    expect(markIndex).toBeGreaterThan(-1);
    expect(warrantIndex).toBeGreaterThan(markIndex);
    expect(baseRiskIndex).toBeGreaterThan(warrantIndex);
  });

  it('shares BUY cooldown key between BUYCALL and BUYPUT for the same symbol', async () => {
    let buyApiCallCount = 0;
    const trader = createTraderDouble({
      getAccountSnapshot: async () => {
        buyApiCallCount += 1;
        return createAccountSnapshotDouble(100000);
      },
      getStockPositions: async () => [],
      _canTradeNow: () => ({ canTrade: true }),
    });

    const pipeline = createRiskCheckPipeline({
      tradingConfig: createTradingConfig(),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
      lastRiskCheckTime,
    });

    const riskChecker = createRiskCheckerDouble();
    const orderRecorder = createOrderRecorderDouble();
    const context = createContext({
      trader,
      riskChecker,
      orderRecorder,
      longSymbol: 'BULL.HK',
      shortSymbol: 'BULL.HK',
    });

    const first = createSignalDouble('BUYCALL', 'BULL.HK');
    const second = createSignalDouble('BUYPUT', 'BULL.HK');

    const firstResult = await withMockedNow(40_000, async () => pipeline([first], context));
    const secondResult = await withMockedNow(40_001, async () => pipeline([second], context));

    expect(firstResult).toHaveLength(1);
    expect(secondResult).toHaveLength(0);
    expect(second.reason).toContain('风险检查冷却期内');
    expect(buyApiCallCount).toBe(1);
  });

  it('rejects buy on batch API failure but keeps sell path available', async () => {
    const buySignal = createSignalDouble('BUYCALL', 'BULL.HK');
    const sellSignal = createSignalDouble('SELLCALL', 'BULL.HK');
    const trader = createTraderDouble({
      getAccountSnapshot: async () => {
        throw new Error('api down');
      },
      getStockPositions: async () => [],
    });

    const pipeline = createRiskCheckPipeline({
      tradingConfig: createTradingConfig(),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
      lastRiskCheckTime,
    });

    const riskChecker = createRiskCheckerDouble({
      checkBeforeOrder: (params) => {
        if (params.signal?.action === 'SELLCALL') {
          return { allowed: true };
        }
        return { allowed: false, reason: 'buy blocked' };
      },
    });

    const result = await withMockedNow(50_000, async () =>
      pipeline([buySignal, sellSignal], createContext({
        trader,
        riskChecker,
        orderRecorder: createOrderRecorderDouble(),
      })),
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.action).toBe('SELLCALL');
    expect(buySignal.reason).toContain('批量获取账户和持仓信息失败');
  });
});

/**
 * risk-pipeline 回归测试
 *
 * 功能：
 * - 验证风险管道回归场景与业务期望。
 */
import { describe, expect, it } from 'bun:test';

import type { RiskCheckContext } from '../../src/types/services.js';
import { createRiskCheckPipeline } from '../../src/core/signalProcessor/riskCheckPipeline.js';
import { createTradingConfig } from '../../mock/factories/configFactory.js';
import {
  createAccountSnapshotDouble,
  createDoomsdayProtectionDouble,
  createLiquidationCooldownTrackerDouble,
  createMonitorConfigDouble,
  createOrderRecorderDouble,
  createPositionCacheDouble,
  createPositionDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createSignalDouble,
  createTraderDouble,
} from '../helpers/testDoubles.js';
import { createBuyThrottle } from '../../src/core/trader/orderExecutor/buyThrottle.js';

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
  readonly account?: ReturnType<typeof createAccountSnapshotDouble>;
  readonly positions?: ReadonlyArray<RiskCheckContext['positions'][number]>;
}): RiskCheckContext {
  const monitorConfig = createMonitorConfigDouble();
  const account = params.account ?? createAccountSnapshotDouble(100_000);
  const positions = params.positions ?? [];

  return {
    trader: params.trader,
    riskChecker: params.riskChecker,
    orderRecorder: params.orderRecorder,
    longQuote: createQuoteDouble('BULL.HK', 1),
    shortQuote: createQuoteDouble('BEAR.HK', 1),
    monitorQuote: createQuoteDouble('HSI.HK', 20_000),
    monitorSnapshot: {
      price: 20_000,
      changePercent: 0,
      ema: null,
      rsi: null,
      psy: null,
      mfi: null,
      kdj: { k: 50, d: 50, j: 50 },
      macd: { macd: 0, dif: 0, dea: 0 },
      adx: null,
    },
    longSymbol: 'BULL.HK',
    shortSymbol: 'BEAR.HK',
    longSymbolName: 'BULL',
    shortSymbolName: 'BEAR',
    account,
    positions,
    lastState: {
      cachedAccount: account,
      cachedPositions: positions,
      positionCache: createPositionCacheDouble(positions),
    },
    currentTime: new Date('2026-02-16T10:00:00+08:00'),
    isHalfDay: false,
    doomsdayProtection: createDoomsdayProtectionDouble(),
    config: monitorConfig,
  };
}

describe('risk pipeline regression', () => {
  it('does not preempt same-direction buy slot in risk check stage', async () => {
    const lastRiskCheckTime = new Map<string, number>();
    const buyThrottle = createBuyThrottle();
    const trader = createTraderDouble({
      canTradeNow: buyThrottle.canTradeNow,
      getAccountSnapshot: async () => createAccountSnapshotDouble(100_000),
      getStockPositions: async () => [],
    });

    const pipeline = createRiskCheckPipeline({
      tradingConfig: createTradingConfig(),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
      lastRiskCheckTime,
    });
    const context = createContext({
      trader,
      riskChecker: createRiskCheckerDouble(),
      orderRecorder: createOrderRecorderDouble(),
    });

    const firstBuy = createSignalDouble('BUYCALL', 'BULL.HK');
    const firstResult = await withMockedNow(100_000, async () => pipeline([firstBuy], context));

    expect(firstResult).toHaveLength(1);

    const secondBuy = createSignalDouble('BUYCALL', 'BULL.HK');
    const secondResult = await withMockedNow(110_001, async () => pipeline([secondBuy], context));

    expect(secondResult).toHaveLength(1);
    expect(secondBuy.reason).toBeUndefined();

    const buyTradeCheck = await withMockedNow(110_001, async () =>
      buyThrottle.canTradeNow('BUYCALL', context.config),
    );
    expect(buyTradeCheck.canTrade).toBe(true);
  });

  it('skips realtime fetch when mixed-batch buy is rejected by light checks and keeps sell on cached context', async () => {
    const lastRiskCheckTime = new Map<string, number>();
    let accountFetchCount = 0;
    let positionFetchCount = 0;
    const cachedAccount = createAccountSnapshotDouble(77_777);
    const cachedPositions = [
      createPositionDouble({
        symbol: 'BULL.HK',
        quantity: 500,
        availableQuantity: 400,
      }),
    ];

    const trader = createTraderDouble({
      canTradeNow: () => ({ canTrade: false, waitSeconds: 59 }),
      getAccountSnapshot: async () => {
        accountFetchCount += 1;
        return createAccountSnapshotDouble(100_000);
      },
      getStockPositions: async () => {
        positionFetchCount += 1;
        return [];
      },
    });

    const pipeline = createRiskCheckPipeline({
      tradingConfig: createTradingConfig(),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
      lastRiskCheckTime,
    });

    const buySignal = createSignalDouble('BUYCALL', 'BULL.HK');
    const sellSignal = createSignalDouble('SELLCALL', 'BULL.HK');

    const result = await withMockedNow(200_000, async () =>
      pipeline(
        [buySignal, sellSignal],
        createContext({
          trader,
          riskChecker: createRiskCheckerDouble({
            checkBeforeOrder: ({ account, positions, signal }) => {
              if (signal?.action === 'SELLCALL') {
                return {
                  allowed: account === cachedAccount && positions === cachedPositions,
                  reason: 'sell should use cached context',
                };
              }

              return { allowed: false, reason: 'unexpected buy base risk check' };
            },
          }),
          orderRecorder: createOrderRecorderDouble(),
          account: cachedAccount,
          positions: cachedPositions,
        }),
      ),
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(sellSignal);
    expect(buySignal.reason).toContain('交易频率限制');
    expect(accountFetchCount).toBe(0);
    expect(positionFetchCount).toBe(0);
  });

  it('keeps sell path on cached context when buy realtime fetch fails after light checks', async () => {
    const lastRiskCheckTime = new Map<string, number>();
    const cachedAccount = createAccountSnapshotDouble(88_888);
    const cachedPositions = [
      createPositionDouble({
        symbol: 'BULL.HK',
        quantity: 200,
        availableQuantity: 100,
      }),
    ];

    const trader = createTraderDouble({
      canTradeNow: () => ({ canTrade: true }),
      getAccountSnapshot: async () => {
        throw new Error('buy api down');
      },
      getStockPositions: async () => [],
    });

    const pipeline = createRiskCheckPipeline({
      tradingConfig: createTradingConfig(),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble({
        getRemainingMs: () => 0,
      }),
      lastRiskCheckTime,
    });

    const buySignal = createSignalDouble('BUYCALL', 'BULL.HK');
    const sellSignal = createSignalDouble('SELLCALL', 'BULL.HK');

    const result = await withMockedNow(300_000, async () =>
      pipeline(
        [buySignal, sellSignal],
        createContext({
          trader,
          riskChecker: createRiskCheckerDouble({
            checkWarrantRisk: () => ({ allowed: true }),
            checkBeforeOrder: ({ account, positions, signal }) => {
              if (signal?.action === 'SELLCALL') {
                return {
                  allowed: account === cachedAccount && positions === cachedPositions,
                  reason: 'sell should use cached context',
                };
              }

              return { allowed: false, reason: 'unexpected buy base risk check' };
            },
          }),
          orderRecorder: createOrderRecorderDouble({
            getLatestBuyOrderPrice: () => null,
          }),
          account: cachedAccount,
          positions: cachedPositions,
        }),
      ),
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(sellSignal);
    expect(buySignal.reason).toContain('获取实时账户和持仓信息失败');
  });
});

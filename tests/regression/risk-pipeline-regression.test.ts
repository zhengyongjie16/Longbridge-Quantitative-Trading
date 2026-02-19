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
  createQuoteDouble,
  createRiskCheckerDouble,
  createSignalDouble,
  createTraderDouble,
} from '../helpers/testDoubles.js';

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
}): RiskCheckContext {
  const monitorConfig = createMonitorConfigDouble();

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
    },
    longSymbol: 'BULL.HK',
    shortSymbol: 'BEAR.HK',
    longSymbolName: 'BULL',
    shortSymbolName: 'BEAR',
    account: createAccountSnapshotDouble(100_000),
    positions: [],
    lastState: {
      cachedAccount: createAccountSnapshotDouble(100_000),
      cachedPositions: [],
      positionCache: createPositionCacheDouble([]),
    },
    currentTime: new Date('2026-02-16T10:00:00+08:00'),
    isHalfDay: false,
    doomsdayProtection: createDoomsdayProtectionDouble(),
    config: monitorConfig,
  };
}

describe('risk pipeline regression', () => {
  it('marks buy attempt early enough to block the second same-batch buy signal', async () => {
    const lastRiskCheckTime = new Map<string, number>();
    let buySlotOccupied = false;
    let markBuyAttemptCount = 0;
    let buyApiFetchCount = 0;

    const trader = createTraderDouble({
      getAccountSnapshot: async () => {
        buyApiFetchCount += 1;
        return createAccountSnapshotDouble(100_000);
      },
      getStockPositions: async () => [],
      canTradeNow: () => {
        if (buySlotOccupied) {
          return { canTrade: false, waitSeconds: 59 };
        }
        return { canTrade: true };
      },
      recordBuyAttempt: () => {
        markBuyAttemptCount += 1;
        buySlotOccupied = true;
      },
    });

    const pipeline = createRiskCheckPipeline({
      tradingConfig: createTradingConfig(),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
      lastRiskCheckTime,
    });

    const firstBuy = createSignalDouble('BUYCALL', 'BULL.HK');
    const secondBuy = createSignalDouble('BUYCALL', 'BULL.HK');

    const result = await withMockedNow(100_000, async () =>
      pipeline(
        [firstBuy, secondBuy],
        createContext({
          trader,
          riskChecker: createRiskCheckerDouble(),
          orderRecorder: createOrderRecorderDouble(),
        }),
      ),
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(firstBuy);
    expect(secondBuy.reason).toContain('交易频率限制');
    expect(markBuyAttemptCount).toBe(1);
    expect(buyApiFetchCount).toBe(1);
  });

  it('uses separated BUY/SELL cooldown keys for the same symbol', async () => {
    const nowMs = 200_000;
    const lastRiskCheckTime = new Map<string, number>([
      ['BULL.HK_BUY', nowMs - 1_000],
    ]);
    let buyApiFetchCount = 0;

    const trader = createTraderDouble({
      getAccountSnapshot: async () => {
        buyApiFetchCount += 1;
        return createAccountSnapshotDouble(100_000);
      },
      getStockPositions: async () => [],
    });

    const pipeline = createRiskCheckPipeline({
      tradingConfig: createTradingConfig(),
      liquidationCooldownTracker: createLiquidationCooldownTrackerDouble(),
      lastRiskCheckTime,
    });

    const buySignal = createSignalDouble('BUYCALL', 'BULL.HK');
    const sellSignal = createSignalDouble('SELLCALL', 'BULL.HK');

    const result = await withMockedNow(nowMs, async () =>
      pipeline(
        [buySignal, sellSignal],
        createContext({
          trader,
          riskChecker: createRiskCheckerDouble({
            checkBeforeOrder: ({ signal }) => ({
              allowed: signal?.action === 'SELLCALL',
            }),
          }),
          orderRecorder: createOrderRecorderDouble(),
        }),
      ),
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(sellSignal);
    expect(buySignal.reason).toContain('风险检查冷却期内');
    expect(buyApiFetchCount).toBe(0);
  });
});

/**
 * liquidation-cooldown-recovery 集成测试
 *
 * 功能：
 * - 验证启动日志恢复后，单方向冷却会对同监控标的双方向买入生效。
 */
import { describe, expect, it } from 'bun:test';
import { TRADING } from '../../src/constants/index.js';
import { createSignalProcessor } from '../../src/core/signalProcessor/index.js';
import { createLiquidationCooldownTracker } from '../../src/services/liquidationCooldown/index.js';
import { createTradeLogHydrator } from '../../src/services/liquidationCooldown/tradeLogHydrator.js';
import type { RiskCheckContext } from '../../src/types/services.js';
import { createMonitorConfig, createTradingConfig } from '../../mock/factories/configFactory.js';
import { createSignal } from '../../mock/factories/signalFactory.js';
import {
  createAccountSnapshotDouble,
  createDoomsdayProtectionDouble,
  createOrderRecorderDouble,
  createPositionCacheDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createTraderDouble,
} from '../helpers/testDoubles.js';

function withMockedNow<T>(nowMs: number, run: () => Promise<T>): Promise<T> {
  const originalNow = Date.now;
  Date.now = () => nowMs;
  return run().finally(() => {
    Date.now = originalNow;
  });
}

function createCompletedRecord(params: {
  readonly monitorSymbol: string;
  readonly action: 'SELLCALL' | 'SELLPUT';
  readonly executedAtMs: number;
}): Record<string, unknown> {
  return {
    orderId: null,
    symbol: null,
    symbolName: null,
    monitorSymbol: params.monitorSymbol,
    action: params.action,
    side: 'SELL',
    quantity: null,
    price: null,
    orderType: null,
    status: 'FILLED',
    error: null,
    reason: TRADING.PROTECTIVE_LIQUIDATION_COMPLETED_REASON,
    signalTriggerTime: null,
    executedAt: null,
    executedAtMs: params.executedAtMs,
    timestamp: null,
    isProtectiveClearance: true,
  };
}

function createRiskContext(params: {
  readonly trader: ReturnType<typeof createTraderDouble>;
  readonly riskChecker: ReturnType<typeof createRiskCheckerDouble>;
  readonly orderRecorder: ReturnType<typeof createOrderRecorderDouble>;
  readonly monitorConfig: ReturnType<typeof createMonitorConfig>;
}): RiskCheckContext {
  const cachedAccount = createAccountSnapshotDouble(100_000);
  return {
    trader: params.trader,
    riskChecker: params.riskChecker,
    orderRecorder: params.orderRecorder,
    longQuote: createQuoteDouble(params.monitorConfig.longSymbol, 5, 100),
    shortQuote: createQuoteDouble(params.monitorConfig.shortSymbol, 5, 100),
    monitorQuote: createQuoteDouble(params.monitorConfig.monitorSymbol, 20_000),
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
    longSymbol: params.monitorConfig.longSymbol,
    shortSymbol: params.monitorConfig.shortSymbol,
    longSymbolName: params.monitorConfig.longSymbol,
    shortSymbolName: params.monitorConfig.shortSymbol,
    account: cachedAccount,
    positions: [],
    lastState: {
      cachedAccount,
      cachedPositions: [],
      positionCache: createPositionCacheDouble([]),
    },
    currentTime: new Date('2026-03-13T10:00:00+08:00'),
    isHalfDay: false,
    doomsdayProtection: createDoomsdayProtectionDouble(),
    config: params.monitorConfig,
  };
}

async function assertDualDirectionBuyBlockedAfterHydration(params: {
  readonly nowMs: number;
  readonly recordAction: 'SELLCALL' | 'SELLPUT';
  readonly expectedBoundaryKey: 'HSI.HK:LONG' | 'HSI.HK:SHORT';
}): Promise<void> {
  const monitorConfig = createMonitorConfig({
    monitorSymbol: 'HSI.HK',
    liquidationTriggerLimit: 1,
    liquidationCooldown: { mode: 'minutes', minutes: 5 },
  });
  const tradingConfig = createTradingConfig({
    monitors: [monitorConfig],
  });
  const tracker = createLiquidationCooldownTracker({
    nowMs: () => params.nowMs,
  });
  const executedAtMs = params.nowMs - 30_000;
  const hydrator = createTradeLogHydrator({
    readFileSync: () =>
      JSON.stringify([
        createCompletedRecord({
          monitorSymbol: 'HSI.HK',
          action: params.recordAction,
          executedAtMs,
        }),
      ]),
    existsSync: () => true,
    resolveLogRootDir: () => process.cwd(),
    nowMs: () => params.nowMs,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    tradingConfig,
    liquidationCooldownTracker: tracker,
  });

  const boundaries = hydrator.hydrate();
  expect(boundaries.get(params.expectedBoundaryKey)).toBe(executedAtMs);

  const trader = createTraderDouble({
    getAccountSnapshot: async () => createAccountSnapshotDouble(100_000),
    getStockPositions: async () => [],
    canTradeNow: () => ({ canTrade: true }),
  });
  const signalProcessor = createSignalProcessor({
    tradingConfig,
    liquidationCooldownTracker: tracker,
  });
  const context = createRiskContext({
    trader,
    riskChecker: createRiskCheckerDouble(),
    orderRecorder: createOrderRecorderDouble(),
    monitorConfig,
  });
  const buyCallSignal = createSignal({
    symbol: 'BULL.HK',
    action: 'BUYCALL',
    triggerTimeMs: params.nowMs,
    price: 5,
    lotSize: 100,
    reason: 'recovery-cooldown-buycall',
  });
  const buyPutSignal = createSignal({
    symbol: 'BEAR.HK',
    action: 'BUYPUT',
    triggerTimeMs: params.nowMs,
    price: 5,
    lotSize: 100,
    reason: 'recovery-cooldown-buyput',
  });

  const buyCallResult = await withMockedNow(params.nowMs, async () =>
    signalProcessor.applyRiskChecks([buyCallSignal], context),
  );
  const buyPutResult = await withMockedNow(params.nowMs + 10, async () =>
    signalProcessor.applyRiskChecks([buyPutSignal], context),
  );

  expect(buyCallResult).toHaveLength(0);
  expect(buyPutResult).toHaveLength(0);
  expect(buyCallSignal.reason).toBe('recovery-cooldown-buycall');
  expect(buyPutSignal.reason).toBe('recovery-cooldown-buyput');
}

describe('liquidation-cooldown-recovery integration', () => {
  it('isolates cooldown by monitor symbol and only blocks the affected monitor in both buy directions', async () => {
    const nowMs = Date.parse('2026-03-13T10:00:00+08:00');
    const monitorA = createMonitorConfig({
      originalIndex: 1,
      monitorSymbol: 'HSI.HK',
      longSymbol: 'A-BULL.HK',
      shortSymbol: 'A-BEAR.HK',
      liquidationTriggerLimit: 1,
      liquidationCooldown: { mode: 'minutes', minutes: 5 },
    });
    const monitorB = createMonitorConfig({
      originalIndex: 2,
      monitorSymbol: 'HSCEI.HK',
      longSymbol: 'B-BULL.HK',
      shortSymbol: 'B-BEAR.HK',
      liquidationTriggerLimit: 1,
      liquidationCooldown: { mode: 'minutes', minutes: 5 },
    });
    const tradingConfig = createTradingConfig({
      monitors: [monitorA, monitorB],
    });
    const tracker = createLiquidationCooldownTracker({
      nowMs: () => nowMs,
    });
    const hydrator = createTradeLogHydrator({
      readFileSync: () =>
        JSON.stringify([
          createCompletedRecord({
            monitorSymbol: monitorA.monitorSymbol,
            action: 'SELLCALL',
            executedAtMs: nowMs - 30_000,
          }),
        ]),
      existsSync: () => true,
      resolveLogRootDir: () => process.cwd(),
      nowMs: () => nowMs,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      tradingConfig,
      liquidationCooldownTracker: tracker,
    });

    const boundaries = hydrator.hydrate();
    expect(boundaries.get('HSI.HK:LONG')).toBe(nowMs - 30_000);
    expect(boundaries.get('HSCEI.HK:LONG')).toBeUndefined();
    expect(boundaries.get('HSCEI.HK:SHORT')).toBeUndefined();

    const traderA = createTraderDouble({
      getAccountSnapshot: async () => createAccountSnapshotDouble(100_000),
      getStockPositions: async () => [],
      canTradeNow: () => ({ canTrade: true }),
    });
    const traderB = createTraderDouble({
      getAccountSnapshot: async () => createAccountSnapshotDouble(100_000),
      getStockPositions: async () => [],
      canTradeNow: () => ({ canTrade: true }),
    });
    const signalProcessor = createSignalProcessor({
      tradingConfig,
      liquidationCooldownTracker: tracker,
    });
    const contextA = createRiskContext({
      trader: traderA,
      riskChecker: createRiskCheckerDouble(),
      orderRecorder: createOrderRecorderDouble(),
      monitorConfig: monitorA,
    });
    const contextB = createRiskContext({
      trader: traderB,
      riskChecker: createRiskCheckerDouble(),
      orderRecorder: createOrderRecorderDouble(),
      monitorConfig: monitorB,
    });

    const monitorABuyCallSignal = createSignal({
      symbol: monitorA.longSymbol,
      action: 'BUYCALL',
      triggerTimeMs: nowMs,
      price: 5,
      lotSize: 100,
      reason: 'monitorA-buycall',
    });
    const monitorABuyPutSignal = createSignal({
      symbol: monitorA.shortSymbol,
      action: 'BUYPUT',
      triggerTimeMs: nowMs,
      price: 5,
      lotSize: 100,
      reason: 'monitorA-buyput',
    });
    const monitorBBuyCallSignal = createSignal({
      symbol: monitorB.longSymbol,
      action: 'BUYCALL',
      triggerTimeMs: nowMs,
      price: 5,
      lotSize: 100,
      reason: 'monitorB-buycall',
    });
    const monitorBBuyPutSignal = createSignal({
      symbol: monitorB.shortSymbol,
      action: 'BUYPUT',
      triggerTimeMs: nowMs,
      price: 5,
      lotSize: 100,
      reason: 'monitorB-buyput',
    });

    const monitorABuyCallResult = await withMockedNow(nowMs, async () =>
      signalProcessor.applyRiskChecks([monitorABuyCallSignal], contextA),
    );
    const monitorABuyPutResult = await withMockedNow(nowMs + 10, async () =>
      signalProcessor.applyRiskChecks([monitorABuyPutSignal], contextA),
    );
    const monitorBBuyCallResult = await withMockedNow(nowMs + 20, async () =>
      signalProcessor.applyRiskChecks([monitorBBuyCallSignal], contextB),
    );
    const monitorBBuyPutResult = await withMockedNow(nowMs + 30, async () =>
      signalProcessor.applyRiskChecks([monitorBBuyPutSignal], contextB),
    );

    expect(monitorABuyCallResult).toHaveLength(0);
    expect(monitorABuyPutResult).toHaveLength(0);
    expect(monitorABuyCallSignal.reason).toBe('monitorA-buycall');
    expect(monitorABuyPutSignal.reason).toBe('monitorA-buyput');

    expect(monitorBBuyCallResult).toHaveLength(1);
    expect(monitorBBuyPutResult).toHaveLength(1);
    expect(monitorBBuyCallSignal.reason).toBe('monitorB-buycall');
    expect(monitorBBuyPutSignal.reason).toBe('monitorB-buyput');
  });

  it('blocks BUYCALL and BUYPUT after hydrating only LONG cooldown records', async () => {
    const nowMs = Date.parse('2026-03-13T10:00:00+08:00');
    await assertDualDirectionBuyBlockedAfterHydration({
      nowMs,
      recordAction: 'SELLCALL',
      expectedBoundaryKey: 'HSI.HK:LONG',
    });
  });

  it('blocks BUYCALL and BUYPUT after hydrating only SHORT cooldown records', async () => {
    const nowMs = Date.parse('2026-03-13T10:00:00+08:00');
    await assertDualDirectionBuyBlockedAfterHydration({
      nowMs,
      recordAction: 'SELLPUT',
      expectedBoundaryKey: 'HSI.HK:SHORT',
    });
  });

  it('does not block BUYCALL and BUYPUT when hydrated cooldown record is already expired', async () => {
    const nowMs = Date.parse('2026-03-13T10:00:00+08:00');
    const monitorConfig = createMonitorConfig({
      monitorSymbol: 'HSI.HK',
      liquidationTriggerLimit: 1,
      liquidationCooldown: { mode: 'minutes', minutes: 5 },
    });
    const tradingConfig = createTradingConfig({
      monitors: [monitorConfig],
    });
    const tracker = createLiquidationCooldownTracker({
      nowMs: () => nowMs,
    });
    const executedAtMs = nowMs - 6 * 60_000;
    const hydrator = createTradeLogHydrator({
      readFileSync: () =>
        JSON.stringify([
          createCompletedRecord({
            monitorSymbol: 'HSI.HK',
            action: 'SELLCALL',
            executedAtMs,
          }),
        ]),
      existsSync: () => true,
      resolveLogRootDir: () => process.cwd(),
      nowMs: () => nowMs,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      tradingConfig,
      liquidationCooldownTracker: tracker,
    });

    hydrator.hydrate();

    const trader = createTraderDouble({
      getAccountSnapshot: async () => createAccountSnapshotDouble(100_000),
      getStockPositions: async () => [],
      canTradeNow: () => ({ canTrade: true }),
    });
    const signalProcessor = createSignalProcessor({
      tradingConfig,
      liquidationCooldownTracker: tracker,
    });
    const context = createRiskContext({
      trader,
      riskChecker: createRiskCheckerDouble(),
      orderRecorder: createOrderRecorderDouble(),
      monitorConfig,
    });
    const buyCallSignal = createSignal({
      symbol: 'BULL.HK',
      action: 'BUYCALL',
      triggerTimeMs: nowMs,
      price: 5,
      lotSize: 100,
      reason: 'recovery-expired-buycall',
    });
    const buyPutSignal = createSignal({
      symbol: 'BEAR.HK',
      action: 'BUYPUT',
      triggerTimeMs: nowMs,
      price: 5,
      lotSize: 100,
      reason: 'recovery-expired-buyput',
    });

    const buyCallResult = await withMockedNow(nowMs, async () =>
      signalProcessor.applyRiskChecks([buyCallSignal], context),
    );
    const buyPutResult = await withMockedNow(nowMs + 10, async () =>
      signalProcessor.applyRiskChecks([buyPutSignal], context),
    );

    expect(buyCallResult).toHaveLength(1);
    expect(buyPutResult).toHaveLength(1);
    expect(buyCallSignal.reason).not.toContain('清仓冷却期内');
    expect(buyPutSignal.reason).not.toContain('清仓冷却期内');
  });
});

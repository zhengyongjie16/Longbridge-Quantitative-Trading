/**
 * @module tests/integration/auto-symbol-switch.integration.test.ts
 * @description 测试模块，围绕 auto-symbol-switch.integration.test.ts 场景验证 tests/integration 相关业务行为与边界条件。
 */
import { describe, expect, it, mock } from 'bun:test';

let candidateQueue: Array<{ symbol: string; callPrice: number } | null> = [];

// eslint-disable-next-line @typescript-eslint/no-floating-promises -- bun:test mock.module 同步注册
mock.module('../../src/services/autoSymbolFinder/index.js', () => ({
  findBestWarrant: async () => candidateQueue.shift() ?? null,
}));

import { createAutoSymbolManager } from '../../src/services/autoSymbolManager/index.js';

import {
  createMonitorConfigDouble,
  createOrderRecorderDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
  createTraderDouble,
} from '../helpers/testDoubles.js';

describe('auto-symbol-switch integration', () => {
  it('runs empty-seat search then distance-triggered switch with sell->rebuy flow', async () => {
    candidateQueue = [
      { symbol: 'OLD_BULL.HK', callPrice: 20_000 },
      { symbol: 'NEW_BULL.HK', callPrice: 21_000 },
    ];

    const monitorConfig = createMonitorConfigDouble({
      targetNotional: 5_000,
      autoSearchConfig: {
        autoSearchEnabled: true,
        autoSearchMinDistancePctBull: 0.35,
        autoSearchMinDistancePctBear: -0.35,
        autoSearchMinTurnoverPerMinuteBull: 100_000,
        autoSearchMinTurnoverPerMinuteBear: 100_000,
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 0,
        switchDistanceRangeBull: { min: 0.2, max: 1.5 },
        switchDistanceRangeBear: { min: -1.5, max: -0.2 },
      },
    });

    const symbolRegistry = createSymbolRegistryDouble({
      monitorSymbol: monitorConfig.monitorSymbol,
      longSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      shortSeat: {
        symbol: null,
        status: 'EMPTY',
        lastSwitchAt: null,
        lastSearchAt: null,
        searchFailCountToday: 0,
        frozenTradingDayKey: null,
      },
      longVersion: 1,
      shortVersion: 1,
    });

    const executedActions: Array<{ action: string | null | undefined; symbol: string | null | undefined; quantity: number | null | undefined }> = [];
    const trader = createTraderDouble({
      executeSignals: async (signals) => {
        const signal = signals[0];
        executedActions.push({
          action: signal?.action,
          symbol: signal?.symbol,
          quantity: signal?.quantity,
        });
        return { submittedCount: 1 };
      },
      getPendingOrders: async () => [],
      cancelOrder: async () => true,
    });

    const orderRecorder = createOrderRecorderDouble({
      getLatestSellRecord: () => ({
        orderId: 'SELL-1',
        symbol: 'OLD_BULL.HK',
        executedPrice: 2,
        executedQuantity: 100,
        executedTime: 9_999_999_999_999,
        submittedAt: undefined,
        updatedAt: undefined,
      }),
    });

    const riskChecker = createRiskCheckerDouble({
      getWarrantDistanceInfo: (isLongSymbol) => {
        if (!isLongSymbol) {
          return null;
        }
        return {
          warrantType: 'BULL',
          distanceToStrikePercent: 0.1,
        };
      },
    });

    const manager = createAutoSymbolManager({
      monitorConfig,
      symbolRegistry,
      marketDataClient: {
        getQuoteContext: async () => ({}) as never,
        getQuotes: async () => new Map(),
        subscribeSymbols: async () => {},
        unsubscribeSymbols: async () => {},
        subscribeCandlesticks: async () => [],
        getRealtimeCandlesticks: async () => [],
        isTradingDay: async () => ({ isTradingDay: true, isHalfDay: false }),
        resetRuntimeSubscriptionsAndCaches: async () => {},
      },
      trader,
      orderRecorder,
      riskChecker,
      now: () => new Date('2026-02-16T01:00:00.000Z'),
    });

    await manager.maybeSearchOnTick({
      direction: 'LONG',
      currentTime: new Date('2026-02-16T01:00:00.000Z'),
      canTradeNow: true,
    });

    const searchedSeat = symbolRegistry.getSeatState(monitorConfig.monitorSymbol, 'LONG');
    expect(searchedSeat.status).toBe('READY');
    expect(searchedSeat.symbol).toBe('OLD_BULL.HK');
    expect(symbolRegistry.getSeatVersion(monitorConfig.monitorSymbol, 'LONG')).toBe(2);

    await manager.maybeSwitchOnDistance({
      direction: 'LONG',
      monitorPrice: 20_000,
      quotesMap: new Map([
        ['OLD_BULL.HK', createQuoteDouble('OLD_BULL.HK', 1, 100)],
        ['NEW_BULL.HK', createQuoteDouble('NEW_BULL.HK', 1, 100)],
      ]),
      positions: [
        {
          symbol: 'OLD_BULL.HK',
          quantity: 100,
          availableQuantity: 100,
          symbolName: 'OLD_BULL',
          accountChannel: 'lb_papertrading',
          currency: 'HKD',
          costPrice: 1,
          market: 'HK',
        },
      ],
    });

    expect(manager.hasPendingSwitch('LONG')).toBeTrue();
    expect(executedActions).toHaveLength(1);
    expect(executedActions[0]?.action).toBe('SELLCALL');

    await manager.maybeSwitchOnDistance({
      direction: 'LONG',
      monitorPrice: 20_000,
      quotesMap: new Map([
        ['OLD_BULL.HK', createQuoteDouble('OLD_BULL.HK', 1, 100)],
        ['NEW_BULL.HK', createQuoteDouble('NEW_BULL.HK', 1, 100)],
      ]),
      positions: [],
    });

    expect(executedActions).toHaveLength(2);
    expect(executedActions[1]?.action).toBe('BUYCALL');
    expect(executedActions[1]?.symbol).toBe('NEW_BULL.HK');
    expect(executedActions[1]?.quantity).toBe(200);

    const finalSeat = symbolRegistry.getSeatState(monitorConfig.monitorSymbol, 'LONG');
    expect(finalSeat.status).toBe('READY');
    expect(finalSeat.symbol).toBe('NEW_BULL.HK');
    expect(finalSeat.callPrice).toBe(21_000);
    expect(symbolRegistry.getSeatVersion(monitorConfig.monitorSymbol, 'LONG')).toBe(3);
    expect(manager.hasPendingSwitch('LONG')).toBeFalse();
  });
});

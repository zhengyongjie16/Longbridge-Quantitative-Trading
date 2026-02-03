import dotenv from 'dotenv';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config/config.index.js';
import { createMarketDataClient } from '../src/services/quoteClient/index.js';
import { mainProgram } from '../src/main/mainProgram/index.js';
import { createIndicatorCache } from '../src/main/asyncProgram/indicatorCache/index.js';
import { createBuyTaskQueue, createSellTaskQueue } from '../src/main/asyncProgram/tradeTaskQueue/index.js';
import { createMonitorTaskQueue } from '../src/main/asyncProgram/monitorTaskQueue/index.js';
import { createSymbolRegistry } from '../src/services/autoSymbolManager/utils.js';
import {
  createLastState,
  createMonitorConfig,
  createMonitorContextForTest,
  createTradingConfig,
} from './utils.js';
import type { DailyLossTracker } from '../src/core/risk/types.js';
import type { DoomsdayProtection } from '../src/core/doomsdayProtection/types.js';
import type { MarketMonitor } from '../src/services/marketMonitor/types.js';
import type { OrderMonitorWorker } from '../src/main/asyncProgram/orderMonitorWorker/types.js';
import type { PostTradeRefresher } from '../src/main/asyncProgram/postTradeRefresher/types.js';
import type { SignalProcessor } from '../src/core/signalProcessor/types.js';
import type { Trader } from '../src/types/index.js';
import type { MonitorTaskData, MonitorTaskType } from '../src/main/asyncProgram/monitorTaskProcessor/types.js';

dotenv.config({ path: '.env.local' });

const env = process.env;
const requiredKeys = ['LONGPORT_APP_KEY', 'LONGPORT_APP_SECRET', 'LONGPORT_ACCESS_TOKEN'];
const hasCreds = requiredKeys.every((key) => {
  const value = env[key];
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('your_');
});
const monitorSymbol = env['INTEGRATION_MONITOR_SYMBOL'] ?? env['MONITOR_SYMBOL_1'] ?? '';

const closeMarketContext = async (client: Awaited<ReturnType<typeof createMarketDataClient>>): Promise<void> => {
  const rawCtx = await client._getContext();
  const ctx = rawCtx as unknown as {
    close?: () => void;
    disconnect?: () => void;
    destroy?: () => void;
    drop?: () => void;
    release?: () => void;
  };
  const closer = ctx.close ?? ctx.disconnect ?? ctx.destroy ?? ctx.drop ?? ctx.release;
  if (typeof closer === 'function') {
    closer.call(rawCtx);
  }
};

const run = async (): Promise<void> => {
  if (!hasCreds || monitorSymbol.length === 0) {
    console.log(JSON.stringify({
      quoteOk: false,
      candlesCount: 0,
      tradingDayChecked: false,
      mainProgramSymbolsOk: false,
      mainProgramQuoteOk: false,
      skipped: true,
    }));
    return;
  }

  const config = createConfig({ env });
  const client = await createMarketDataClient({ config });

  let quoteOk = false;
  let candlesCount = 0;
  let tradingDayChecked = false;
  let mainProgramSymbolsOk = false;
  let mainProgramQuoteOk = false;

  try {
    await assert.rejects(() => client.getQuotes([monitorSymbol]));

    await client.subscribeSymbols([monitorSymbol]);

    const quotesMap = await client.getQuotes([monitorSymbol]);
    const quote = quotesMap.get(monitorSymbol) ?? null;
    quoteOk = Boolean(quote && Number.isFinite(quote.price));

    const candles = await client.getCandlesticks(monitorSymbol, '1m', 5);
    candlesCount = candles.length;

    const tradingDay = await client.isTradingDay(new Date());
    tradingDayChecked = typeof tradingDay.isTradingDay === 'boolean';

    const autoSearchConfig = {
      autoSearchEnabled: true,
      autoSearchMinPriceBull: null,
      autoSearchMinPriceBear: null,
      autoSearchMinTurnoverPerMinuteBull: null,
      autoSearchMinTurnoverPerMinuteBear: null,
      autoSearchExpiryMinMonths: 3,
      autoSearchOpenDelayMinutes: 5,
      switchDistanceRangeBull: null,
      switchDistanceRangeBear: null,
    };

    const monitorConfig = createMonitorConfig({
      monitorSymbol,
      longSymbol: monitorSymbol,
      shortSymbol: monitorSymbol,
      autoSearchConfig,
    });
    const tradingConfig = createTradingConfig({ monitors: [monitorConfig] });
    const symbolRegistry = createSymbolRegistry([monitorConfig]);

    const { context: monitorContext, state } = createMonitorContextForTest({
      monitorConfig,
      symbolRegistry,
      quotesMap: new Map(quotesMap),
      strategy: {
        generateCloseSignals: () => ({ immediateSignals: [], delayedSignals: [] }),
      },
    });

    const lastState = createLastState({
      monitorStates: new Map([[monitorSymbol, state]]),
    });

    await mainProgram({
      marketDataClient: client,
      trader: { getOrderHoldSymbols: () => new Set(), getAndClearPendingRefreshSymbols: () => [] } as unknown as Trader,
      lastState,
      marketMonitor: {
        monitorPriceChanges: () => false,
        monitorIndicatorChanges: () => false,
      } as MarketMonitor,
      doomsdayProtection: {
        cancelPendingBuyOrders: async () => ({ executed: false, cancelledCount: 0 }),
        executeClearance: async () => ({ executed: false }),
      } as unknown as DoomsdayProtection,
      signalProcessor: {} as SignalProcessor,
      tradingConfig,
      dailyLossTracker: {
        initializeFromOrders: () => undefined,
        recalculateFromAllOrders: () => undefined,
        recordFilledOrder: () => undefined,
        getLossOffset: () => 0,
        resetIfNewDay: () => undefined,
      } as unknown as DailyLossTracker,
      monitorContexts: new Map([[monitorSymbol, monitorContext]]),
      symbolRegistry,
      indicatorCache: createIndicatorCache(),
      buyTaskQueue: createBuyTaskQueue(),
      sellTaskQueue: createSellTaskQueue(),
      monitorTaskQueue: createMonitorTaskQueue<MonitorTaskType, MonitorTaskData>(),
      orderMonitorWorker: { schedule: () => undefined, stop: () => undefined } as OrderMonitorWorker,
      postTradeRefresher: { enqueue: () => undefined, stop: () => undefined } as PostTradeRefresher,
      runtimeGateMode: 'skip',
    });

    mainProgramSymbolsOk = lastState.allTradingSymbols.has(monitorSymbol);
    mainProgramQuoteOk = monitorContext.monitorQuote !== null;
  } finally {
    await client.unsubscribeSymbols([monitorSymbol]);
    await closeMarketContext(client);
  }

  console.log(JSON.stringify({
    quoteOk,
    candlesCount,
    tradingDayChecked,
    mainProgramSymbolsOk,
    mainProgramQuoteOk,
  }));
};

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

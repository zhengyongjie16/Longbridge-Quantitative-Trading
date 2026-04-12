/**
 * processMonitor/index 业务测试
 *
 * 功能：
 * - 验证 processMonitor 主流程相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';

import {
  createBuyTaskQueue,
  createSellTaskQueue,
} from '../../../src/main/asyncProgram/tradeTaskQueue/index.js';
import { createMonitorTaskQueue } from '../../../src/main/asyncProgram/monitorTaskQueue/index.js';
import type { ProcessMonitorParams } from '../../../src/main/processMonitor/types.js';
import type { Quote } from '../../../src/types/quote.js';
import type { MonitorContext } from '../../../src/types/state.js';
import {
  createMonitorConfigDouble,
  createPositionCacheDouble,
  createQuoteDouble,
} from '../../helpers/testDoubles.js';
import { createMonitorContext as createMonitorContextFromAsync } from '../asyncProgram/utils.js';

type ProcessMonitorFn = (
  context: ProcessMonitorParams,
  quotesMap: ReadonlyMap<string, Quote | null>,
) => void;

async function loadProcessMonitor(): Promise<ProcessMonitorFn> {
  const modulePath = '../../../src/main/processMonitor/index.js?real-process-monitor';
  const module = await import(modulePath);
  return module.processMonitor as ProcessMonitorFn;
}

function createMonitorContext(params: {
  readonly autoSearchEnabled: boolean;
  readonly switchIntervalMinutes?: number;
}): MonitorContext {
  return createMonitorContextFromAsync({
    config: createMonitorConfigDouble({
      monitorSymbol: 'HSI.HK',
      autoSearchConfig: {
        autoSearchEnabled: params.autoSearchEnabled,
        autoSearchMinDistancePctBull: 0.35,
        autoSearchMinDistancePctBear: -0.35,
        autoSearchMinTurnoverPerMinuteBull: 100_000,
        autoSearchMinTurnoverPerMinuteBear: 100_000,
        autoSearchExpiryMinMonths: 3,
        autoSearchOpenDelayMinutes: 0,
        switchIntervalMinutes: params.switchIntervalMinutes ?? 0,
        switchDistanceRangeBull: { min: 0.2, max: 1.5 },
        switchDistanceRangeBear: { min: -1.5, max: -0.2 },
      },
    }),
    state: {
      monitorSymbol: 'HSI.HK',
      longPrice: null,
      shortPrice: null,
      signal: null,
      pendingDelayedSignals: [],
      monitorValues: null,
      lastMonitorSnapshot: null,
      incrementalIndicatorRuntime: null,
    },
  });
}

describe('processMonitor end-to-end orchestration', () => {
  it('does not enqueue buy/sell signals when only running auto-symbol and risk scheduling', async () => {
    const processMonitor = await loadProcessMonitor();
    const monitorContext = createMonitorContext({
      autoSearchEnabled: false,
    });

    const buyTaskQueue = createBuyTaskQueue();
    const sellTaskQueue = createSellTaskQueue();
    const monitorTaskQueue = createMonitorTaskQueue();

    const params: ProcessMonitorParams = {
      context: {
        marketDataClient: {},
        marketMonitor: {
          monitorPriceChanges: () => false,
          monitorIndicatorChanges: () => false,
        },
        buyTaskQueue,
        sellTaskQueue,
        monitorTaskQueue,
        lastState: {
          positionCache: createPositionCacheDouble(),
        },
      } as never,
      monitorContext,
      runtimeFlags: {
        currentTime: new Date('2026-02-16T01:00:00.000Z'),
        isHalfDay: false,
        canTradeNow: true,
        openProtectionActive: false,
        isTradingEnabled: true,
      },
    };

    processMonitor(params, new Map([['HSI.HK', createQuoteDouble('HSI.HK', 20_010)]]));

    expect(monitorTaskQueue.isEmpty()).toBeTrue();
    expect(buyTaskQueue.isEmpty()).toBeTrue();
    expect(sellTaskQueue.isEmpty()).toBeTrue();
  });

  it('schedules periodic auto-symbol tasks and still keeps buy/sell queues untouched', async () => {
    const processMonitor = await loadProcessMonitor();
    const monitorContext = createMonitorContext({
      autoSearchEnabled: true,
      switchIntervalMinutes: 30,
    });

    const buyTaskQueue = createBuyTaskQueue();
    const sellTaskQueue = createSellTaskQueue();
    const monitorTaskQueue = createMonitorTaskQueue();

    const params: ProcessMonitorParams = {
      context: {
        marketDataClient: {},
        marketMonitor: {
          monitorPriceChanges: () => false,
          monitorIndicatorChanges: () => false,
        },
        buyTaskQueue,
        sellTaskQueue,
        monitorTaskQueue,
        lastState: {
          positionCache: createPositionCacheDouble(),
        },
      } as never,
      monitorContext,
      runtimeFlags: {
        currentTime: new Date('2026-02-16T01:00:01.000Z'),
        isHalfDay: false,
        canTradeNow: true,
        openProtectionActive: false,
        isTradingEnabled: true,
      },
    };

    processMonitor(
      params,
      new Map([
        ['HSI.HK', createQuoteDouble('HSI.HK', 20_050)],
        ['BULL.HK', createQuoteDouble('BULL.HK', 1.1)],
        ['BEAR.HK', createQuoteDouble('BEAR.HK', 0.9)],
      ]),
    );

    expect(monitorTaskQueue.pop()?.type).toBe('AUTO_SYMBOL_TICK');
    expect(monitorTaskQueue.pop()?.type).toBe('AUTO_SYMBOL_TICK');
    expect(buyTaskQueue.isEmpty()).toBeTrue();
    expect(sellTaskQueue.isEmpty()).toBeTrue();
  });
});

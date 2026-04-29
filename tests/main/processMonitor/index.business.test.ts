/**
 * processMonitor/index 业务测试
 *
 * 功能：
 * - 验证 processMonitor 只保留时间语义任务调度，不再承担席位同步或信号清理。
 */
import { describe, expect, it } from 'bun:test';

import {
  createBuyTaskQueue,
  createSellTaskQueue,
} from '../../../src/main/asyncProgram/tradeTaskQueue/index.js';
import { createMonitorTaskQueue } from '../../../src/main/asyncProgram/monitorTaskQueue/index.js';
import type { MonitorTaskDataMap } from '../../../src/main/asyncProgram/monitorTaskProcessor/types.js';
import type { ProcessMonitorParams } from '../../../src/main/processMonitor/types.js';
import type { IndicatorSnapshot } from '../../../src/types/quote.js';
import type { MonitorContext } from '../../../src/types/state.js';
import {
  createDelayedSignalVerifierDouble,
  createMonitorConfigDouble,
  createRiskCheckerDouble,
  createSignalDouble,
} from '../../helpers/testDoubles.js';
import { createMonitorContext as createMonitorContextFromAsync } from '../asyncProgram/utils.js';

type ProcessMonitorFn = (context: ProcessMonitorParams) => void;

async function loadProcessMonitor(): Promise<ProcessMonitorFn> {
  const modulePath = '../../../src/main/processMonitor/index.js?real-process-monitor';
  const module = await import(modulePath);
  return module.processMonitor as ProcessMonitorFn;
}

function createProcessMonitorParams(monitorContext: MonitorContext): Readonly<{
  readonly params: ProcessMonitorParams;
  readonly monitorTaskQueue: ReturnType<typeof createMonitorTaskQueue<MonitorTaskDataMap>>;
}> {
  const monitorTaskQueue = createMonitorTaskQueue<MonitorTaskDataMap>();
  return {
    params: {
      context: {
        monitorTaskQueue,
      },
      monitorContext,
      currentTime: new Date('2026-02-16T01:00:00.000Z'),
    },
    monitorTaskQueue,
  };
}

function createIndicatorSnapshot(overrides: Partial<IndicatorSnapshot> = {}): IndicatorSnapshot {
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

function createMonitorContext(
  params: {
    readonly autoSearchEnabled: boolean;
    readonly switchIntervalMinutes?: number;
  },
  overrides: Partial<MonitorContext> = {},
): MonitorContext {
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
      signal: null,
      pendingDelayedSignals: [],
      lastMonitorSnapshot: null,
      incrementalIndicatorRuntime: null,
    },
    ...overrides,
  });
}

describe('processMonitor end-to-end orchestration', () => {
  it('does not enqueue buy/sell signals when only running auto-symbol scheduling', async () => {
    const processMonitor = await loadProcessMonitor();
    const monitorContext = createMonitorContext({
      autoSearchEnabled: false,
    });
    const buyTaskQueue = createBuyTaskQueue();
    const sellTaskQueue = createSellTaskQueue();

    const { params, monitorTaskQueue } = createProcessMonitorParams(monitorContext);

    processMonitor(params);

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

    const { params, monitorTaskQueue } = createProcessMonitorParams(monitorContext);

    processMonitor({
      ...params,
      currentTime: new Date('2026-02-16T01:00:01.000Z'),
    });

    expect(monitorTaskQueue.pop()?.type).toBe('AUTO_SYMBOL_TICK');
    expect(monitorTaskQueue.pop()?.type).toBe('AUTO_SYMBOL_TICK');
    expect(buyTaskQueue.isEmpty()).toBeTrue();
    expect(sellTaskQueue.isEmpty()).toBeTrue();
  });

  it('does not read candlestick cache or trigger monitor rendering from processMonitor', async () => {
    const processMonitor = await loadProcessMonitor();
    const monitorContext = createMonitorContext({
      autoSearchEnabled: false,
    });
    monitorContext.state.lastMonitorSnapshot = createIndicatorSnapshot();
    const buyTaskQueue = createBuyTaskQueue();
    const sellTaskQueue = createSellTaskQueue();

    const { params } = createProcessMonitorParams(monitorContext);

    processMonitor(params);

    expect(buyTaskQueue.isEmpty()).toBeTrue();
    expect(sellTaskQueue.isEmpty()).toBeTrue();
  });

  it('does not clean stale direction runtime when cached seat leaves ACTIVE', async () => {
    const processMonitor = await loadProcessMonitor();
    let clearLongCalls = 0;
    let delayedCancelCalls = 0;
    const monitorContext = createMonitorContext(
      {
        autoSearchEnabled: false,
      },
      {
        riskChecker: createRiskCheckerDouble({
          clearLongWarrantInfo: () => {
            clearLongCalls += 1;
          },
        }),
        delayedSignalVerifier: createDelayedSignalVerifierDouble({
          cancelAllForDirection: () => {
            delayedCancelCalls += 1;
            return 1;
          },
        }),
      },
    );
    const buyTaskQueue = createBuyTaskQueue();
    buyTaskQueue.push({
      type: 'IMMEDIATE_BUY',
      monitorSymbol: monitorContext.config.monitorSymbol,
      data: createSignalDouble('BUYCALL', 'BULL.HK'),
    });

    const { params } = createProcessMonitorParams(monitorContext);

    processMonitor(params);

    expect(clearLongCalls).toBe(0);
    expect(delayedCancelCalls).toBe(0);
    expect(buyTaskQueue.pop()?.data.action).toBe('BUYCALL');
  });
});

/**
 * orderMonitorWorker 业务测试
 *
 * 功能：
 * - 验证订单监控工作器相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';

import { createOrderMonitorWorker } from '../../../../src/main/asyncProgram/orderMonitorWorker/index.js';

import type { Quote } from '../../../../src/types/quote.js';

type Deferred = {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
};

function createQuotes(symbol: string, price: number): ReadonlyMap<string, Quote | null> {
  return new Map([
    [
      symbol,
      {
        symbol,
        name: symbol,
        price,
        prevClose: price,
        timestamp: Date.now(),
      },
    ],
  ]);
}

function createDeferred(): Deferred {
  let resolver: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolver = resolve;
  });
  return {
    promise,
    resolve: () => {
      resolver?.();
    },
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs: number = 800): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('waitUntil timeout');
    }
    await Bun.sleep(10);
  }
}

describe('orderMonitorWorker business flow', () => {
  it('uses latest-overwrite strategy while keeping single in-flight execution', async () => {
    const startedPrices: number[] = [];
    const finishQueue: Array<() => void> = [];

    const worker = createOrderMonitorWorker({
      monitorAndManageOrders: async (quotesMap) => {
        const price = quotesMap.get('BULL.HK')?.price ?? 0;
        startedPrices.push(price);
        await new Promise<void>((resolve) => {
          finishQueue.push(resolve);
        });
      },
    });

    worker.schedule(createQuotes('BULL.HK', 1));
    await waitUntil(() => startedPrices.length === 1);

    worker.schedule(createQuotes('BULL.HK', 2));
    worker.schedule(createQuotes('BULL.HK', 3));

    const firstFinish = finishQueue.shift();
    firstFinish?.();

    await waitUntil(() => startedPrices.length === 2);
    const secondFinish = finishQueue.shift();
    secondFinish?.();

    await worker.stopAndDrain();

    expect(startedPrices).toEqual([1, 3]);
  });

  it('stopAndDrain waits for in-flight run and ignores new schedules after stop', async () => {
    let runningCount = 0;
    let finishGate: Deferred | undefined;

    const worker = createOrderMonitorWorker({
      monitorAndManageOrders: async () => {
        runningCount += 1;
        finishGate = createDeferred();
        await finishGate.promise;
      },
    });

    worker.schedule(createQuotes('BULL.HK', 1));
    await waitUntil(() => runningCount === 1);

    const drainPromise = worker.stopAndDrain();
    worker.schedule(createQuotes('BULL.HK', 2));

    await Bun.sleep(30);
    expect(runningCount).toBe(1);

    finishGate?.resolve();
    await drainPromise;

    expect(runningCount).toBe(1);
  });

  it('clearLatestQuotes drops pending latest task after current run', async () => {
    const executedPrices: number[] = [];
    let firstRunGate: Deferred | undefined;

    const worker = createOrderMonitorWorker({
      monitorAndManageOrders: async (quotesMap) => {
        executedPrices.push(quotesMap.get('BULL.HK')?.price ?? 0);
        if (executedPrices.length === 1) {
          firstRunGate = createDeferred();
          await firstRunGate.promise;
        }
      },
    });

    worker.schedule(createQuotes('BULL.HK', 1));
    await waitUntil(() => executedPrices.length === 1);

    worker.schedule(createQuotes('BULL.HK', 2));
    worker.clearLatestQuotes();

    firstRunGate?.resolve();
    await Bun.sleep(50);
    await worker.stopAndDrain();

    expect(executedPrices).toEqual([1]);
  });
});

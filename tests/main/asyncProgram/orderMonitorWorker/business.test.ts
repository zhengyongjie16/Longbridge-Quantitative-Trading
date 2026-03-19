/**
 * orderMonitorWorker 业务测试
 *
 * 功能：
 * - 验证订单监控工作器相关场景意图、边界条件与业务期望。
 */
import { describe, expect, it } from 'bun:test';

import { createOrderMonitorWorker } from '../../../../src/main/asyncProgram/orderMonitorWorker/index.js';

type Deferred = {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
};

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
    let runCount = 0;
    const finishQueue: Array<() => void> = [];

    const worker = createOrderMonitorWorker({
      monitorAndManageOrders: async () => {
        runCount += 1;
        await new Promise<void>((resolve) => {
          finishQueue.push(resolve);
        });
      },
    });

    worker.schedule();
    await waitUntil(() => runCount === 1);

    worker.schedule();
    worker.schedule();

    const firstFinish = finishQueue.shift();
    firstFinish?.();

    await waitUntil(() => runCount === 2);
    const secondFinish = finishQueue.shift();
    secondFinish?.();

    await worker.stopAndDrain();

    expect(runCount).toBe(2);
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

    worker.schedule();
    await waitUntil(() => runningCount === 1);

    const drainPromise = worker.stopAndDrain();
    worker.schedule();

    await Bun.sleep(30);
    expect(runningCount).toBe(1);

    finishGate?.resolve();
    await drainPromise;

    expect(runningCount).toBe(1);
  });

  it('drops queued rerun after stopAndDrain clears pending work', async () => {
    let runCount = 0;
    let firstRunGate: Deferred | undefined;

    const worker = createOrderMonitorWorker({
      monitorAndManageOrders: async () => {
        runCount += 1;
        if (runCount === 1) {
          firstRunGate = createDeferred();
          await firstRunGate.promise;
        }
      },
    });

    worker.schedule();
    await waitUntil(() => runCount === 1);

    worker.schedule();

    const drainPromise = worker.stopAndDrain();
    firstRunGate?.resolve();
    await drainPromise;

    expect(runCount).toBe(1);
  });
});

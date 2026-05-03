/**
 * TimeWakeupRuntime 业务测试
 *
 * 覆盖系统级 one-shot 时间唤醒 runtime 的 start、dirty、停止等待与恢复性 retry 语义。
 */
import { describe, expect, it } from 'bun:test';
import { createTimeWakeupRuntime } from '../../../src/main/timeWakeupRuntime/index.js';
import type { TimeWakeupPlan } from '../../../src/main/timeWakeupPlanner/types.js';

type TimerRecord = {
  readonly callback: () => void;
  readonly delayMs: number;
  cleared: boolean;
};

type RuntimeHarness = Readonly<{
  runtime: ReturnType<typeof createTimeWakeupRuntime<TimerRecord>>;
  timers: ReadonlyArray<TimerRecord>;
  evaluations: ReadonlyArray<number>;
  setNowMs: (value: number) => void;
  rejectNextEvaluation: () => void;
}>;

type ControlledEvaluationHarness = Readonly<{
  runtime: ReturnType<typeof createTimeWakeupRuntime<TimerRecord>>;
  timers: ReadonlyArray<TimerRecord>;
  beginStopping: () => void;
  resolveEvaluation: (result: { readonly nextWakeupAtMs: number | null }) => void;
  scheduledAfterStop: () => boolean;
}>;

function createPlan(nextWakeupAtMs: number | null): TimeWakeupPlan {
  if (nextWakeupAtMs === null) {
    return { hasWork: false, nextWakeupAtMs: null, candidates: [] };
  }

  return {
    hasWork: true,
    nextWakeupAtMs,
    candidates: [{ source: 'TRADING_GATE_EDGE', atMs: nextWakeupAtMs }],
  };
}

function createRuntimeHarness(
  options: { readonly nextWakeupAtMs?: number | null } = {},
): RuntimeHarness {
  const timers: TimerRecord[] = [];
  const evaluations: number[] = [];
  let nowMs = 1_000;
  let rejectNext = false;

  const runtime = createTimeWakeupRuntime<TimerRecord>({
    evaluate: async () => {
      evaluations.push(nowMs);
      if (rejectNext) {
        rejectNext = false;
        throw new Error('evaluation failed');
      }

      return {
        plan: createPlan(options.nextWakeupAtMs ?? nowMs + 1_000),
      };
    },
    now: () => new Date(nowMs),
    scheduleTimer: (callback, delayMs) => {
      const timer: TimerRecord = { callback, delayMs, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      handle.cleared = true;
    },
    recoveryRetryDelayMs: 500,
    logger: {
      error: () => {},
    },
  });

  return {
    runtime,
    timers,
    evaluations,
    setNowMs: (value) => {
      nowMs = value;
    },
    rejectNextEvaluation: () => {
      rejectNext = true;
    },
  };
}

function createControlledEvaluationHarness(): ControlledEvaluationHarness {
  const timers: TimerRecord[] = [];
  const nowMs = 1_000;
  let resolveEvaluation: ((nextWakeupAtMs: number | null) => void) | null = null;
  let scheduledAfterStop = false;
  let stopping = false;

  const runtime = createTimeWakeupRuntime<TimerRecord>({
    evaluate: async () => {
      const nextWakeupAtMs = await new Promise<number | null>((resolve) => {
        resolveEvaluation = resolve;
      });
      return { plan: createPlan(nextWakeupAtMs) };
    },
    now: () => new Date(nowMs),
    scheduleTimer: (callback, delayMs) => {
      if (stopping) {
        scheduledAfterStop = true;
      }

      const timer: TimerRecord = { callback, delayMs, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      handle.cleared = true;
    },
    recoveryRetryDelayMs: 500,
    logger: {
      error: () => {},
    },
  });

  return {
    runtime,
    timers,
    beginStopping: () => {
      stopping = true;
    },
    resolveEvaluation: (result: { readonly nextWakeupAtMs: number | null }) => {
      resolveEvaluation?.(result.nextWakeupAtMs);
    },
    scheduledAfterStop: () => scheduledAfterStop,
  };
}

describe('TimeWakeupRuntime', () => {
  it('start 立即评估一次并安排一个 one-shot timer', async () => {
    const harness = createRuntimeHarness();

    harness.runtime.start();
    await Bun.sleep(0);

    expect(harness.evaluations).toEqual([1_000]);
    expect(harness.timers).toHaveLength(1);
    expect(harness.timers[0]?.delayMs).toBe(1_000);
  });

  it('重复 start 不会重复评估或重复安排 timer', async () => {
    const harness = createRuntimeHarness();

    harness.runtime.start();
    harness.runtime.start();
    await Bun.sleep(0);

    expect(harness.evaluations).toEqual([1_000]);
    expect(harness.timers).toHaveLength(1);
  });

  it('评估中 requestEvaluate 标记 dirty 并在当前评估后再运行一次', async () => {
    const harness = createRuntimeHarness();

    harness.runtime.start();
    harness.runtime.requestEvaluate();
    await Bun.sleep(0);
    await Bun.sleep(0);

    expect(harness.evaluations).toEqual([1_000, 1_000]);
  });

  it('timer 触发后清除当前 timer 并重新评估', async () => {
    const harness = createRuntimeHarness();
    harness.runtime.start();
    await Bun.sleep(0);

    harness.setNowMs(2_000);
    harness.timers[0]?.callback();
    await Bun.sleep(0);

    expect(harness.evaluations).toEqual([1_000, 2_000]);
  });

  it('stopAndDrain 清理 timer 并等待在途评估', async () => {
    const harness = createRuntimeHarness();
    harness.runtime.start();
    await Bun.sleep(0);

    await harness.runtime.stopAndDrain();

    expect(harness.timers[0]?.cleared).toBe(true);
  });

  it('stopAndDrain 阻止晚到评估结果继续安排 timer', async () => {
    const harness = createControlledEvaluationHarness();
    harness.runtime.start();

    harness.beginStopping();
    const stopPromise = harness.runtime.stopAndDrain();
    harness.resolveEvaluation({ nextWakeupAtMs: 2_000 });
    await stopPromise;

    expect(harness.scheduledAfterStop()).toBe(false);
    expect(harness.timers).toHaveLength(0);
  });

  it('评估异常后安排恢复性 retry', async () => {
    const harness = createRuntimeHarness();
    harness.rejectNextEvaluation();

    harness.runtime.start();
    await Bun.sleep(0);

    expect(harness.timers).toHaveLength(1);
    expect(harness.timers[0]?.delayMs).toBe(500);
  });

  it('nextWakeupAtMs 等于当前时间时安排 0ms one-shot timer 而不是恢复性 retry', async () => {
    const harness = createRuntimeHarness({ nextWakeupAtMs: 1_000 });

    harness.runtime.start();
    await Bun.sleep(0);

    expect(harness.timers).toHaveLength(1);
    expect(harness.timers[0]?.delayMs).toBe(0);
    expect(harness.evaluations).toEqual([1_000]);

    harness.timers[0]?.callback();
    await Bun.sleep(0);

    expect(harness.evaluations).toEqual([1_000, 1_000]);
  });

  it('nextWakeupAtMs 早于当前时间时同样安排 0ms one-shot timer', async () => {
    const harness = createRuntimeHarness({ nextWakeupAtMs: 999 });

    harness.runtime.start();
    await Bun.sleep(0);

    expect(harness.timers).toHaveLength(1);
    expect(harness.timers[0]?.delayMs).toBe(0);
    expect(harness.evaluations).toEqual([1_000]);
  });
});

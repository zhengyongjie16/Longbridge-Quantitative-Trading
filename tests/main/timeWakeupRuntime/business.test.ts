/**
 * TimeWakeupRuntime 业务测试
 *
 * 覆盖系统级 one-shot 时间唤醒 runtime 的 start、dirty、停止等待与恢复性 retry 语义。
 */
import { describe, expect, it } from 'bun:test';
import { TIME } from '../../../src/constants/index.js';
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

  it('评估期间刚到达计划边界时立即重评估而不走恢复性 retry', async () => {
    const timers: TimerRecord[] = [];
    const evaluations: number[] = [];
    let nowMs = 1_000;

    const runtime = createTimeWakeupRuntime<TimerRecord>({
      evaluate: async () => {
        evaluations.push(nowMs);
        if (evaluations.length === 1) {
          nowMs = 1_500;
          return { plan: createPlan(1_500) };
        }

        return { plan: createPlan(null) };
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

    runtime.start();
    await Bun.sleep(0);
    await Bun.sleep(0);

    expect(evaluations).toEqual([1_000, 1_500]);
    expect(timers).toHaveLength(0);
  });

  it('nextWakeupAtMs 不是有限数值时停止排程且不进入恢复性 retry', async () => {
    const harness = createRuntimeHarness({ nextWakeupAtMs: Number.NaN });

    harness.runtime.start();
    await Bun.sleep(0);

    expect(harness.timers).toHaveLength(0);

    harness.runtime.requestEvaluate();
    await Bun.sleep(0);

    expect(harness.evaluations).toEqual([1_000]);
  });

  it('评估耗时跨过计划边界时立即重评估而不停止系统级唤醒', async () => {
    const timers: TimerRecord[] = [];
    const evaluations: number[] = [];
    const errors: string[] = [];
    let nowMs = 1_000;

    const runtime = createTimeWakeupRuntime<TimerRecord>({
      evaluate: async () => {
        evaluations.push(nowMs);
        if (evaluations.length === 1) {
          nowMs = 1_001;
          return { plan: createPlan(1_000) };
        }

        return { plan: createPlan(null) };
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
        error: (message) => {
          errors.push(message);
        },
      },
    });

    runtime.start();
    await Bun.sleep(0);
    await Bun.sleep(0);

    expect(evaluations).toEqual([1_000, 1_001]);
    expect(timers).toHaveLength(0);
    expect(errors).toHaveLength(0);
    expect(runtime.getStateSnapshot()).toEqual({
      running: true,
      inFlight: false,
      dirty: false,
      hasTimer: false,
    });
  });

  it('nextWakeupAtMs 超过 timer 最大安全延迟时先安排安全分段 timer', async () => {
    const harness = createRuntimeHarness({
      nextWakeupAtMs: 1_000 + TIME.MAX_TIMER_DELAY_MS + 1,
    });

    harness.runtime.start();
    await Bun.sleep(0);

    expect(harness.timers).toHaveLength(1);
    expect(harness.timers[0]?.delayMs).toBe(TIME.MAX_TIMER_DELAY_MS);
    expect(harness.evaluations).toEqual([1_000]);
  });

  it('分段 timer 回调重排时若计划边界已到达会立即重新评估', async () => {
    const timers: TimerRecord[] = [];
    const evaluations: number[] = [];
    const dueAtMs = 1_000 + TIME.MAX_TIMER_DELAY_MS + 1;
    const nowValues = [1_000, dueAtMs - 1, dueAtMs];

    const runtime = createTimeWakeupRuntime<TimerRecord>({
      evaluate: async () => {
        evaluations.push(evaluations.length + 1);
        if (evaluations.length === 1) {
          return { plan: createPlan(dueAtMs) };
        }

        return { plan: createPlan(null) };
      },
      now: () => new Date(nowValues.shift() ?? dueAtMs),
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

    runtime.start();
    await Bun.sleep(0);
    timers[0]?.callback();
    await Bun.sleep(0);

    expect(evaluations).toEqual([1, 2]);
  });
});

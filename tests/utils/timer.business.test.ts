/**
 * bounded one-shot timer 业务测试
 *
 * 覆盖长时间 one-shot 分段、到期触发、取消和非法时间 fail-fast。
 */
import { describe, expect, it } from 'bun:test';
import { TIME } from '../../src/constants/index.js';
import { scheduleBoundedOneShotAt } from '../../src/utils/timer/index.js';

type TimerRecord = {
  readonly callback: () => void;
  readonly delayMs: number;
  cleared: boolean;
};

function createTimerHarness(startMs: number): Readonly<{
  timers: ReadonlyArray<TimerRecord>;
  now: () => Date;
  setNowMs: (value: number) => void;
  scheduleTimer: (callback: () => void, delayMs: number) => TimerRecord;
  clearTimer: (handle: TimerRecord) => void;
}> {
  const timers: TimerRecord[] = [];
  let nowMs = startMs;

  return {
    timers,
    now: () => new Date(nowMs),
    setNowMs: (value) => {
      nowMs = value;
    },
    scheduleTimer: (callback, delayMs) => {
      const timer: TimerRecord = { callback, delayMs, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      handle.cleared = true;
    },
  };
}

describe('scheduleBoundedOneShotAt', () => {
  it('非法目标时间直接抛错且不注册 timer', () => {
    const harness = createTimerHarness(1_000);

    expect(() =>
      scheduleBoundedOneShotAt({
        atMs: Number.NaN,
        now: harness.now,
        scheduleTimer: harness.scheduleTimer,
        clearTimer: harness.clearTimer,
        onDue: () => {},
      }),
    ).toThrow('one-shot timer 目标时间非法');
    expect(harness.timers).toHaveLength(0);
  });

  it('目标时间已到达时注册 0ms one-shot，避免在调用栈内同步重入', () => {
    const harness = createTimerHarness(2_000);
    let dueCount = 0;

    const controller = scheduleBoundedOneShotAt({
      atMs: 1_000,
      now: harness.now,
      scheduleTimer: harness.scheduleTimer,
      clearTimer: harness.clearTimer,
      onDue: () => {
        dueCount += 1;
      },
    });

    expect(dueCount).toBe(0);
    expect(controller.hasTimer()).toBe(true);
    expect(harness.timers[0]?.delayMs).toBe(0);

    harness.timers[0]?.callback();

    expect(dueCount).toBe(1);
    expect(controller.hasTimer()).toBe(false);
  });

  it('超过平台安全延迟时先注册最大安全分段，分段未到期时继续重排', () => {
    const harness = createTimerHarness(1_000);
    let dueCount = 0;
    const atMs = 1_000 + TIME.MAX_TIMER_DELAY_MS + 5;

    const controller = scheduleBoundedOneShotAt({
      atMs,
      now: harness.now,
      scheduleTimer: harness.scheduleTimer,
      clearTimer: harness.clearTimer,
      onDue: () => {
        dueCount += 1;
      },
    });

    expect(harness.timers).toHaveLength(1);
    expect(harness.timers[0]?.delayMs).toBe(TIME.MAX_TIMER_DELAY_MS);

    harness.setNowMs(atMs - 1);
    harness.timers[0]?.callback();

    expect(dueCount).toBe(0);
    expect(harness.timers[1]?.delayMs).toBe(1);
    expect(controller.hasTimer()).toBe(true);
  });

  it('取消后分段 callback 不会触发到期行为', () => {
    const harness = createTimerHarness(1_000);
    let dueCount = 0;
    const controller = scheduleBoundedOneShotAt({
      atMs: 2_000,
      now: harness.now,
      scheduleTimer: harness.scheduleTimer,
      clearTimer: harness.clearTimer,
      onDue: () => {
        dueCount += 1;
      },
    });

    controller.cancel();
    harness.setNowMs(2_000);
    harness.timers[0]?.callback();

    expect(dueCount).toBe(0);
    expect(harness.timers[0]?.cleared).toBe(true);
    expect(controller.hasTimer()).toBe(false);
  });
});

/**
 * 场景时钟
 *
 * 功能：
 * - 提供可控时间源以驱动测试中的时间推进
 */
export interface ScenarioClock {
  now: () => number;
  set: (timeMs: number) => void;
  tick: (deltaMs: number) => number;
}

/**
 * 创建可控场景时钟。
 *
 * 以 `initialMs` 为起点维护一个可手动推进的时间状态，
 * 供调度器与事件总线共享，确保测试中所有时间相关逻辑使用同一时间源。
 */
export function createScenarioClock(initialMs: number = 0): ScenarioClock {
  let current = initialMs;

  function now(): number {
    return current;
  }

  function set(timeMs: number): void {
    current = timeMs;
  }

  function tick(deltaMs: number): number {
    current += deltaMs;
    return current;
  }

  return {
    now,
    set,
    tick,
  };
}

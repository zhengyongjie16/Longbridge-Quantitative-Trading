export interface ScenarioClock {
  now(): number;
  set(timeMs: number): void;
  tick(deltaMs: number): number;
}

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

/**
 * 场景调度器
 *
 * 功能：
 * - 按时间与序号稳定执行任务并支持批量推进
 */
import type { ScenarioClock } from './clock.js';

type ScheduledTask = {
  readonly runAtMs: number;
  readonly sequence: number;
  readonly task: () => void;
};

export interface ScenarioScheduler {
  scheduleAt: (runAtMs: number, task: () => void) => void;
  scheduleAfter: (delayMs: number, task: () => void) => void;
  runDue: () => number;
  runAll: () => number;
  pendingCount: () => number;
}

/**
 * 对任务按执行时间和插入序排序。
 *
 * 这保证同一时间点上的任务执行顺序可预测，便于测试断言稳定复现。
 */
function sortTasks(tasks: ReadonlyArray<ScheduledTask>): ReadonlyArray<ScheduledTask> {
  return [...tasks].sort((a, b) => {
    if (a.runAtMs !== b.runAtMs) {
      return a.runAtMs - b.runAtMs;
    }
    return a.sequence - b.sequence;
  });
}

/**
 * 创建场景调度器。
 *
 * 调度器与 `ScenarioClock` 协作：`runDue` 只执行当前到期任务，
 * `runAll` 会自动推进时钟直到任务清空，用于快速驱动完整场景。
 */
export function createScenarioScheduler(clock: ScenarioClock): ScenarioScheduler {
  const tasks: ScheduledTask[] = [];
  let sequence = 0;

  function scheduleAt(runAtMs: number, task: () => void): void {
    tasks.push({
      runAtMs,
      sequence,
      task,
    });
    sequence += 1;
  }

  function scheduleAfter(delayMs: number, task: () => void): void {
    scheduleAt(clock.now() + delayMs, task);
  }

  function runDue(): number {
    const nowMs = clock.now();
    const dueTasks = sortTasks(tasks.filter((item) => item.runAtMs <= nowMs));
    if (dueTasks.length === 0) {
      return 0;
    }

    const dueSet = new Set(dueTasks);
    tasks.splice(0, tasks.length, ...tasks.filter((item) => !dueSet.has(item)));

    for (const scheduled of dueTasks) {
      scheduled.task();
    }

    return dueTasks.length;
  }

  function runAll(): number {
    let count = 0;
    while (tasks.length > 0) {
      const earliest = sortTasks(tasks)[0];
      if (!earliest) {
        break;
      }
      if (clock.now() < earliest.runAtMs) {
        clock.set(earliest.runAtMs);
      }
      count += runDue();
    }
    return count;
  }

  function pendingCount(): number {
    return tasks.length;
  }

  return {
    scheduleAt,
    scheduleAfter,
    runDue,
    runAll,
    pendingCount,
  };
}

/**
 * @module mock/scenario/scenarioBuilder.ts
 * @description 场景构建器模块，按 given/when/then 组织测试步骤并驱动调度执行。
 */
import type { ScenarioClock } from './clock.js';
import type { ScenarioScheduler } from './scheduler.js';

export type ScenarioGiven = () => void;
export type ScenarioWhen = () => void;
export type ScenarioThen = () => void;

export interface ScenarioBuilder {
  given(setup: ScenarioGiven): ScenarioBuilder;
  whenAt(timeMs: number, action: ScenarioWhen): ScenarioBuilder;
  whenAfter(delayMs: number, action: ScenarioWhen): ScenarioBuilder;
  then(assertion: ScenarioThen): ScenarioBuilder;
  run(): void;
}

/**
 * 创建 Given/When/Then 风格的场景构建器。
 *
 * 通过将 setup、调度动作与断言拆分存储，保证测试步骤书写清晰，
 * 同时复用统一调度器推进事件时序。
 */
export function createScenarioBuilder(
  clock: ScenarioClock,
  scheduler: ScenarioScheduler,
): ScenarioBuilder {
  const givenSteps: ScenarioGiven[] = [];
  const thenSteps: ScenarioThen[] = [];

  function given(setup: ScenarioGiven): ScenarioBuilder {
    givenSteps.push(setup);
    return api;
  }

  function whenAt(timeMs: number, action: ScenarioWhen): ScenarioBuilder {
    scheduler.scheduleAt(timeMs, action);
    return api;
  }

  function whenAfter(delayMs: number, action: ScenarioWhen): ScenarioBuilder {
    scheduler.scheduleAfter(delayMs, action);
    return api;
  }

  function then(assertion: ScenarioThen): ScenarioBuilder {
    thenSteps.push(assertion);
    return api;
  }

  function run(): void {
    // 按 Given -> When(runAll) -> Then 固定顺序执行，避免断言时序不确定。
    for (const setup of givenSteps) {
      setup();
    }

    scheduler.runAll();

    for (const assertion of thenSteps) {
      assertion();
    }
  }

  const api: ScenarioBuilder = {
    given,
    whenAt,
    whenAfter,
    then,
    run,
  };

  // 默认让场景从当前 clock 起点启动，显式保留这一步便于断点调试
  clock.set(clock.now());

  return api;
}

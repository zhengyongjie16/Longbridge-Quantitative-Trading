import type { TimeWakeupEvaluationResult } from '../timeWakeupEvaluationProgram/types.js';
import type { Logger } from '../../utils/logger/types.js';

/**
 * TimeWakeupRuntime timer 句柄。
 * 类型用途：保存由注入 timer 能力返回的 one-shot timer 句柄。
 * 数据来源：TimeWakeupRuntimeDeps.scheduleTimer。
 * 使用范围：TimeWakeupRuntime 依赖泛型与内部状态。
 */
type TimeWakeupTimerHandle = ReturnType<typeof setTimeout>;

/**
 * TimeWakeupRuntime 状态快照。
 * 类型用途：描述系统级时间唤醒 runtime 的可观测运行状态。
 * 数据来源：TimeWakeupRuntime 内部 running/inFlight/dirty/timer 状态。
 * 使用范围：诊断与测试辅助。
 */
export type TimeWakeupRuntimeStateSnapshot = Readonly<{
  running: boolean;
  inFlight: boolean;
  dirty: boolean;
  hasTimer: boolean;
}>;

/**
 * TimeWakeupRuntime 依赖。
 * 类型用途：创建系统级时间事件 owner 所需的单次评估器、timer、时间源与日志。
 * 数据来源：app 装配层。
 * 使用范围：createTimeWakeupRuntime 工厂。
 */
export type TimeWakeupRuntimeDeps<TTimerHandle = TimeWakeupTimerHandle> = Readonly<{
  evaluate: () => Promise<TimeWakeupEvaluationResult>;
  now: () => Date;
  scheduleTimer: (callback: () => void, delayMs: number) => TTimerHandle;
  clearTimer: (handle: TTimerHandle) => void;
  logger: Pick<Logger, 'error'>;
}>;

/**
 * TimeWakeupRuntime。
 * 类型用途：以 one-shot timer 驱动单次权威时间评估的系统级 runtime。
 * 数据来源：由 createTimeWakeupRuntime 创建。
 * 使用范围：app 装配、shutdown cleanup 与显式时间重评估触发点。
 */
export interface TimeWakeupRuntime {
  readonly start: () => Promise<void>;
  readonly requestEvaluate: () => void;
  readonly stopAndDrain: () => Promise<void>;
  readonly drainFatalError: () => Promise<never>;
  readonly getStateSnapshot: () => TimeWakeupRuntimeStateSnapshot;
}

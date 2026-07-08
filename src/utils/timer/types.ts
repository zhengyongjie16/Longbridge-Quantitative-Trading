/**
 * bounded one-shot timer 控制器。
 * 类型用途：暴露取消与可观测 timer 状态，供各局部 timer owner 清理派生计划。
 * 数据来源：scheduleBoundedOneShotAt 返回。
 * 使用范围：系统级和局部 one-shot 时间 owner。
 */
export interface BoundedOneShotTimerController {
  readonly cancel: () => void;
  readonly hasTimer: () => boolean;
}

/**
 * bounded one-shot timer 参数。
 * 类型用途：描述按目标 epoch 毫秒安排 one-shot timer 所需的注入依赖和到期行为。
 * 数据来源：各 timer owner 在计算业务 dueAt 后组装。
 * 使用范围：scheduleBoundedOneShotAt 调用边界。
 */
export type BoundedOneShotTimerParams<TTimerHandle> = Readonly<{
  atMs: number;
  now: () => Date;
  scheduleTimer: (callback: () => void, delayMs: number) => TTimerHandle;
  clearTimer: (handle: TTimerHandle) => void;
  onDue: () => void;
}>;

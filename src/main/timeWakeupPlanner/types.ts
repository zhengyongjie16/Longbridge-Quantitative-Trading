/**
 * 时间唤醒候选来源。
 * 类型用途：标记系统级时间唤醒候选的业务来源。
 * 数据来源：lifecycle、doomsday、交易门禁、HK 日期边界与市场边界计算结果。
 * 使用范围：TimeWakeupPlanner 输入候选与输出计划。
 */
type TimeWakeupCandidateSource =
  | 'API_RETRY'
  | 'LIFECYCLE_RETRY'
  | 'DOOMSDAY_RETRY'
  | 'DOOMSDAY_WINDOW_ENTRY'
  | 'TRADING_GATE_EDGE'
  | 'OPEN_PROTECTION_EDGE'
  | 'MARKET_CLOSE_EDGE'
  | 'HK_DAY_BOUNDARY';

/**
 * 时间唤醒候选。
 * 类型用途：表达一个系统级未来唤醒时间点。
 * 数据来源：外部运行时对各系统级时间边界的计算结果。
 * 使用范围：TimeWakeupPlanner 输入与过滤排序后的输出。
 */
export type TimeWakeupCandidate = Readonly<{
  source: TimeWakeupCandidateSource;
  atMs: number;
}>;

/**
 * 时间唤醒规划输入。
 * 类型用途：提供当前时间与待裁剪的系统级候选集合。
 * 数据来源：事件唤醒运行时装配层。
 * 使用范围：planNextTimeWakeup 纯函数参数。
 */
export type TimeWakeupPlannerInput = Readonly<{
  nowMs: number;
  candidates: ReadonlyArray<TimeWakeupCandidate>;
}>;

/**
 * 时间唤醒规划结果。
 * 类型用途：表达下一次系统级时间唤醒是否存在及其候选快照。
 * 数据来源：planNextTimeWakeup 对输入候选过滤排序后的结果。
 * 使用范围：事件唤醒运行时调度 one-shot timer。
 */
export type TimeWakeupPlan =
  | Readonly<{
      hasWork: false;
      nextWakeupAtMs: null;
      candidates: readonly [];
    }>
  | Readonly<{
      hasWork: true;
      nextWakeupAtMs: number;
      candidates: readonly [TimeWakeupCandidate, ...TimeWakeupCandidate[]];
    }>;

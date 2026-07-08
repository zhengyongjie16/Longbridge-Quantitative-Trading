/**
 * TimeWakeupPlanner
 *
 * 职责：裁剪并排序系统级时间唤醒候选，生成下一次 one-shot 唤醒计划。
 */
import type { TimeWakeupCandidate, TimeWakeupPlan, TimeWakeupPlannerInput } from './types.js';

function isFutureCandidate(candidate: TimeWakeupCandidate, nowMs: number): boolean {
  return Number.isFinite(candidate.atMs) && candidate.atMs > nowMs;
}

/**
 * 规划下一次系统级时间唤醒。
 *
 * @param input 当前时间与候选集合
 * @returns 过滤排序后的下一次唤醒计划
 */
export function planNextTimeWakeup(input: TimeWakeupPlannerInput): TimeWakeupPlan {
  const candidates = [...input.candidates]
    .filter((candidate) => isFutureCandidate(candidate, input.nowMs))
    .sort((left, right) => left.atMs - right.atMs);

  const [nextCandidate, ...remainingCandidates] = candidates;
  if (nextCandidate === undefined) {
    return {
      hasWork: false,
      nextWakeupAtMs: null,
      candidates: [],
    };
  }

  return {
    hasWork: true,
    nextWakeupAtMs: nextCandidate.atMs,
    candidates: [nextCandidate, ...remainingCandidates],
  };
}

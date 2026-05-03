/**
 * TimeWakeupPlanner 业务测试
 *
 * 覆盖：系统级时间候选过滤、排序与最早唤醒选择，不包含周期换标候选。
 */
import { describe, expect, it } from 'bun:test';
import { planNextTimeWakeup } from '../../../src/main/timeWakeupPlanner/index.js';
import type { TimeWakeupCandidate } from '../../../src/main/timeWakeupPlanner/types.js';

describe('TimeWakeupPlanner', () => {
  it('从多个系统级未来候选中选择严格大于 nowMs 的最早时间', () => {
    const nowMs = 1_000;
    const plan = planNextTimeWakeup({
      nowMs,
      candidates: [
        { source: 'DOOMSDAY_RETRY', atMs: 3_000 },
        { source: 'LIFECYCLE_RETRY', atMs: 1_500 },
        { source: 'TRADING_GATE_EDGE', atMs: 2_000 },
      ],
    });

    expect(plan.hasWork).toBe(true);
    expect(plan.nextWakeupAtMs).toBe(1_500);
  });

  it('过滤 atMs 小于或等于 nowMs 的候选', () => {
    const plan = planNextTimeWakeup({
      nowMs: 1_000,
      candidates: [
        { source: 'LIFECYCLE_RETRY', atMs: 999 },
        { source: 'DOOMSDAY_RETRY', atMs: 1_000 },
        { source: 'OPEN_PROTECTION_EDGE', atMs: 1_001 },
      ],
    });

    expect(plan).toEqual({
      hasWork: true,
      nextWakeupAtMs: 1_001,
      candidates: [{ source: 'OPEN_PROTECTION_EDGE', atMs: 1_001 }],
    });
  });

  it('过滤 NaN 和 Infinity 等非法数字候选', () => {
    const plan = planNextTimeWakeup({
      nowMs: 1_000,
      candidates: [
        { source: 'LIFECYCLE_RETRY', atMs: Number.NaN },
        { source: 'DOOMSDAY_RETRY', atMs: Number.POSITIVE_INFINITY },
        { source: 'TRADING_GATE_EDGE', atMs: Number.NEGATIVE_INFINITY },
        { source: 'MARKET_CLOSE_EDGE', atMs: 2_000 },
      ],
    });

    expect(plan).toEqual({
      hasWork: true,
      nextWakeupAtMs: 2_000,
      candidates: [{ source: 'MARKET_CLOSE_EDGE', atMs: 2_000 }],
    });
  });

  it('无有效未来候选时返回 no-work 结果', () => {
    const plan = planNextTimeWakeup({
      nowMs: 1_000,
      candidates: [
        { source: 'LIFECYCLE_RETRY', atMs: 500 },
        { source: 'DOOMSDAY_RETRY', atMs: Number.NaN },
      ],
    });

    expect(plan).toEqual({
      hasWork: false,
      nextWakeupAtMs: null,
      candidates: [],
    });
  });

  it('返回的 candidates 只包含有效未来候选并按 atMs 升序排列', () => {
    const candidates: ReadonlyArray<TimeWakeupCandidate> = [
      { source: 'MARKET_CLOSE_EDGE', atMs: 5_000 },
      { source: 'OPEN_PROTECTION_EDGE', atMs: 2_000 },
      { source: 'DOOMSDAY_RETRY', atMs: 1_500 },
      { source: 'TRADING_GATE_EDGE', atMs: 1_000 },
      { source: 'LIFECYCLE_RETRY', atMs: Number.POSITIVE_INFINITY },
    ];

    const plan = planNextTimeWakeup({
      nowMs: 1_000,
      candidates,
    });

    expect(plan).toEqual({
      hasWork: true,
      nextWakeupAtMs: 1_500,
      candidates: [
        { source: 'DOOMSDAY_RETRY', atMs: 1_500 },
        { source: 'OPEN_PROTECTION_EDGE', atMs: 2_000 },
        { source: 'MARKET_CLOSE_EDGE', atMs: 5_000 },
      ],
    });
  });
});

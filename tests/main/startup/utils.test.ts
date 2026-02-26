/**
 * startup/utils 单元测试
 *
 * 功能：
 * - 验证启动快照失败时的全局状态切换（阻断交易并进入开盘重建重试态）
 */
import { describe, expect, it } from 'bun:test';
import { applyStartupSnapshotFailureState } from '../../../src/main/startup/utils.js';
import type { LastState } from '../../../src/types/state.js';

function createMinimalLastState(): LastState {
  return {
    canTrade: true,
    isHalfDay: false,
    openProtectionActive: false,
    currentDayKey: '2026-02-25',
    lifecycleState: 'ACTIVE',
    pendingOpenRebuild: false,
    targetTradingDayKey: null,
    isTradingEnabled: true,
    cachedAccount: null,
    cachedPositions: [],
    positionCache: {
      update: () => {},
      get: () => null,
    },
    cachedTradingDayInfo: null,
    monitorStates: new Map(),
    allTradingSymbols: new Set(),
  } as unknown as LastState;
}

describe('startup utils', () => {
  it('switches to open-rebuild retry state when startup snapshot load fails', () => {
    const lastState = createMinimalLastState();
    const now = new Date('2026-02-26T10:00:00.000Z');

    applyStartupSnapshotFailureState(lastState, now);

    expect(lastState.pendingOpenRebuild).toBe(true);
    expect(lastState.lifecycleState).toBe('OPEN_REBUILD_FAILED');
    expect(lastState.isTradingEnabled).toBe(false);
    expect(lastState.targetTradingDayKey).toBe('2026-02-26');
  });
});

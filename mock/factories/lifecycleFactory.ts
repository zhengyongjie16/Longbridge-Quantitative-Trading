import type { LifecycleMutableState, LifecycleRuntimeFlags } from '../../src/main/lifecycle/types.js';

export function createLifecycleMutableState(
  overrides: Partial<LifecycleMutableState> = {},
): LifecycleMutableState {
  return {
    currentDayKey: null,
    lifecycleState: 'ACTIVE',
    pendingOpenRebuild: false,
    targetTradingDayKey: null,
    isTradingEnabled: true,
    ...overrides,
  };
}

export function createLifecycleRuntimeFlags(
  overrides: Partial<LifecycleRuntimeFlags> = {},
): LifecycleRuntimeFlags {
  return {
    dayKey: '2026-02-16',
    canTradeNow: true,
    isTradingDay: true,
    ...overrides,
  };
}

/**
 * @module mock/factories/lifecycleFactory.ts
 * @description 生命周期 Mock 工厂模块，用于快速构造生命周期状态与运行时标志。
 */
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

/**
 * 生命周期 Mock 工厂
 *
 * 功能：
 * - 快速构造生命周期状态与运行时标志
 */
import type {
  LifecycleMutableState,
  LifecycleRuntimeFlags,
} from '../../src/main/lifecycle/types.js';

/**
 * 构造生命周期可变状态，供跨日/开盘重建等测试使用；支持部分覆盖默认值。
 */
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

/**
 * 构造生命周期运行时标志，供门控、交易日判断等测试使用；支持部分覆盖。
 */
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

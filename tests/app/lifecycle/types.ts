import type { CacheDomain, LifecycleMutableState } from '../../../src/main/lifecycle/types.js';

/**
 * createLifecycleRuntime 接线测试中的开盘重建委托记录。
 * 类型用途：记录 executeTradingDayOpenRebuild 替身收到的入参，便于断言统一入口接线。
 * 数据来源：由 tests/app/lifecycle/createLifecycleRuntime.wiring.test.ts 中的替身函数收集。
 * 使用范围：仅 app/lifecycle 测试使用。
 */
export type ExecuteOpenRebuildCall = Readonly<{
  now: Date;
  loadTradingDayRuntimeSnapshot: unknown;
  rebuildTradingDayState: unknown;
}>;

/**
 * createLifecycleRuntime 接线测试中的 dayLifecycleManager 创建记录。
 * 类型用途：记录 createDayLifecycleManager 替身收到的可变状态与 cache domains。
 * 数据来源：由 tests/app/lifecycle/createLifecycleRuntime.wiring.test.ts 中的替身函数收集。
 * 使用范围：仅 app/lifecycle 测试使用。
 */
export type CreateDayLifecycleManagerCall = Readonly<{
  mutableState: LifecycleMutableState;
  cacheDomains: ReadonlyArray<CacheDomain>;
}>;

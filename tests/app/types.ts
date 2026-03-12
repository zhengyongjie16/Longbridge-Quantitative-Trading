import type { Quote } from '../../src/types/quote.js';
import type { RawOrderFromAPI } from '../../src/types/services.js';
import type { CacheDomain, LifecycleMutableState } from '../../src/main/lifecycle/types.js';

/**
 * app runApp 测试中的单次重建调用记录。
 * 类型用途：记录测试替身 rebuildTradingDayState 的入参，便于断言时序与统一时间源。
 * 数据来源：由 tests/app/runApp.test.ts 中的替身函数收集。
 * 使用范围：仅 app 测试使用。
 */
type RunAppRebuildCall = Readonly<{
  allOrders: ReadonlyArray<RawOrderFromAPI>;
  quotesMap: ReadonlyMap<string, Quote | null>;
  now?: Date;
}>;

/**
 * app runApp 测试中的可变校验结果。
 * 类型用途：供测试 harness 在用例执行过程中更新校验结果。
 * 数据来源：由 tests/app/runApp.test.ts 的 harness 状态持有。
 * 使用范围：仅 app 测试内部使用。
 */
type MutableRunAppValidationResult = {
  valid: boolean;
  warnings: string[];
  errors: string[];
};

/**
 * app runApp 测试 harness 的可变运行态。
 * 类型用途：供测试用例在执行过程中累积事件与调用统计，再作为只读快照断言。
 * 数据来源：由 tests/app/runApp.test.ts 的 createHarnessState 创建。
 * 使用范围：仅 app 测试内部使用。
 */
export type MutableRunAppHarnessState = {
  events: string[];
  startupRebuildPending: boolean;
  runtimeGateMode: 'strict' | 'skip';
  preGateRuntimeEnv: NodeJS.ProcessEnv | null;
  postGateRuntimeEnv: NodeJS.ProcessEnv | null;
  createPostGateRuntimeNow: Date | null;
  loadStartupSnapshotNow: Date | null;
  rebuildCalls: RunAppRebuildCall[];
  registerDelayedCalls: number;
  cleanupRegistered: number;
  mainProgramCalls: number;
  mainProgramRuntimeGateModes: Array<'strict' | 'skip'>;
  validationResult: MutableRunAppValidationResult;
};

/**
 * app 测试使用的通用任务队列替身接口。
 * 类型用途：为 buy/sell task queue 替身提供稳定返回类型，避免测试文件内联对象类型。
 * 数据来源：由 tests/app/runApp.test.ts 中的 createTaskQueueDouble 返回。
 * 使用范围：仅 app 测试使用。
 */
export type AppTestTaskQueueDouble = Readonly<{
  push: (_task: unknown) => void;
  pop: () => null;
  isEmpty: () => boolean;
  removeTasks: () => number;
  clearAll: () => number;
  onTaskAdded: () => () => void;
}>;

/**
 * createLifecycleRuntime 接线测试中的开盘重建委托记录。
 * 类型用途：记录 executeTradingDayOpenRebuild 替身收到的入参，便于断言统一入口接线。
 * 数据来源：由 tests/app/createLifecycleRuntime.wiring.test.ts 中的替身函数收集。
 * 使用范围：仅 app 测试使用。
 */
export type ExecuteOpenRebuildCall = Readonly<{
  now: Date;
  loadTradingDayRuntimeSnapshot: unknown;
  rebuildTradingDayState: unknown;
}>;

/**
 * createLifecycleRuntime 接线测试中的 dayLifecycleManager 创建记录。
 * 类型用途：记录 createDayLifecycleManager 替身收到的可变状态与 cache domains。
 * 数据来源：由 tests/app/createLifecycleRuntime.wiring.test.ts 中的替身函数收集。
 * 使用范围：仅 app 测试使用。
 */
export type CreateDayLifecycleManagerCall = Readonly<{
  mutableState: LifecycleMutableState;
  cacheDomains: ReadonlyArray<CacheDomain>;
}>;

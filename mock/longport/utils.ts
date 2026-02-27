import type {
  MockCallRecord,
  MockFailureRule,
  MockFailureState,
  MockMethodName,
} from './types.js';

/**
 * 判断方法是否被当前 Mock 支持。默认行为：未命中支持集合返回 false。
 *
 * @param method 方法名
 * @param supportedMethods 支持的方法集合
 * @returns 是否支持
 */
export function isMethodSupported(
  method: MockMethodName,
  supportedMethods: ReadonlySet<MockMethodName>,
): boolean {
  return supportedMethods.has(method);
}

/**
 * 初始化失败注入状态。默认行为：所有计数和规则为空。
 *
 * @returns 初始化后的失败注入状态
 */
export function createFailureState(): MockFailureState {
  return {
    callsByMethod: new Map(),
    failedCountByMethod: new Map(),
    rules: new Map(),
  };
}

/**
 * 递增并返回指定方法调用序号。默认行为：首次调用从 1 开始。
 *
 * @param state 失败注入状态
 * @param method 方法名
 * @returns 当前调用序号（从 1 开始）
 */
export function nextCallIndex(state: MockFailureState, method: MockMethodName): number {
  const next = (state.callsByMethod.get(method) ?? 0) + 1;
  state.callsByMethod.set(method, next);
  return next;
}

/**
 * 按规则判断当前调用是否注入失败。默认行为：无规则或不命中时返回 null。
 *
 * @param state 失败注入状态
 * @param method 方法名
 * @param callIndex 当前调用序号
 * @param args 调用参数
 * @returns 需注入的 Error；不注入时返回 null
 */
export function shouldFail(
  state: MockFailureState,
  method: MockMethodName,
  callIndex: number,
  args: ReadonlyArray<unknown>,
): Error | null {
  const rule = state.rules.get(method);
  if (!rule) {
    return null;
  }

  const byCallList = rule.failAtCalls?.includes(callIndex) ?? false;
  const byEveryCalls =
    typeof rule.failEveryCalls === 'number' &&
    rule.failEveryCalls > 0 &&
    callIndex % rule.failEveryCalls === 0;
  const byPredicate = rule.predicate?.(args) ?? false;
  const shouldMatch = byCallList || byEveryCalls || byPredicate;

  if (!shouldMatch) {
    return null;
  }

  const failedCount = state.failedCountByMethod.get(method) ?? 0;
  const maxFailures = rule.maxFailures ?? Number.POSITIVE_INFINITY;
  if (failedCount >= maxFailures) {
    return null;
  }

  state.failedCountByMethod.set(method, failedCount + 1);
  return new Error(rule.errorMessage ?? `[MockFailure] ${method} call#${callIndex} failed`);
}

/**
 * 写入一次调用日志。默认行为：按入参原样记录到尾部。
 *
 * @param params 调用日志写入参数
 * @returns 无返回值
 */
export function recordCall(params: {
  readonly callRecords: MockCallRecord[];
  readonly method: MockMethodName;
  readonly callIndex: number;
  readonly nowMs: number;
  readonly args: ReadonlyArray<unknown>;
  readonly result: unknown;
  readonly error: Error | null;
}): void {
  const { callRecords, method, callIndex, nowMs, args, result, error } = params;
  callRecords.push({
    method,
    callIndex,
    calledAtMs: nowMs,
    args,
    result,
    error,
  });
}

/**
 * 包装一次 Mock 调用，统一处理计数、失败注入与调用日志。默认行为：异常将包装为 Error 并透传。
 *
 * @param params 调用包装参数
 * @returns action 执行结果
 */
export async function withMockCall<T>(params: {
  readonly state: MockFailureState;
  readonly callRecords: MockCallRecord[];
  readonly method: MockMethodName;
  readonly args: ReadonlyArray<unknown>;
  readonly now: () => number;
  readonly action: () => Promise<T> | T;
}): Promise<T> {
  const { state, callRecords, method, args, now, action } = params;
  const callIndex = nextCallIndex(state, method);
  const injectedError = shouldFail(state, method, callIndex, args);
  if (injectedError) {
    recordCall({
      callRecords,
      method,
      callIndex,
      nowMs: now(),
      args,
      result: null,
      error: injectedError,
    });
    throw injectedError;
  }

  try {
    const result = await action();
    recordCall({
      callRecords,
      method,
      callIndex,
      nowMs: now(),
      args,
      result,
      error: null,
    });
    return result;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    recordCall({
      callRecords,
      method,
      callIndex,
      nowMs: now(),
      args,
      result: null,
      error,
    });
    throw error;
  }
}

/**
 * 设置或清除单个方法失败规则。默认行为：方法不支持时忽略。
 *
 * @param params 规则设置参数
 * @returns 无返回值
 */
export function applyMockFailureRule(params: {
  readonly state: MockFailureState;
  readonly supportedMethods: ReadonlySet<MockMethodName>;
  readonly method: MockMethodName;
  readonly rule: MockFailureRule | null;
}): void {
  const { state, supportedMethods, method, rule } = params;
  if (!isMethodSupported(method, supportedMethods)) {
    return;
  }
  if (!rule) {
    state.rules.delete(method);
    return;
  }
  state.rules.set(method, rule);
}

/**
 * 清空全部失败规则与失败计数。默认行为：调用后规则集合为空。
 *
 * @param state 失败注入状态
 * @returns 无返回值
 */
export function resetMockFailureRules(state: MockFailureState): void {
  state.rules.clear();
  state.failedCountByMethod.clear();
}

/**
 * 读取调用日志。默认行为：method 为空时返回全部日志副本。
 *
 * @param callRecords 调用日志存储
 * @param method 可选方法过滤
 * @returns 调用日志数组副本
 */
export function readMockCalls(
  callRecords: ReadonlyArray<MockCallRecord>,
  method?: MockMethodName,
): ReadonlyArray<MockCallRecord> {
  if (!method) {
    return [...callRecords];
  }
  return callRecords.filter((record) => record.method === method);
}

/**
 * 清空调用日志。默认行为：长度置零。
 *
 * @param callRecords 调用日志存储
 * @returns 无返回值
 */
export function resetMockCallRecords(callRecords: MockCallRecord[]): void {
  callRecords.length = 0;
}

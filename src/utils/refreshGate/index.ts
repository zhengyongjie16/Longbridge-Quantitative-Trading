import type { RefreshGate, RefreshGateAbortReason, RefreshGateStatus, Waiter } from '../types.js';

/**
 * 根据终止原因构造 freshness 等待失败错误。
 *
 * @param reason 当前 freshness 等待被终止的原因
 * @returns 带固定模块前缀的错误对象
 */
function createAbortError(reason: RefreshGateAbortReason): Error {
  return new Error(`[postTradeConsistencyRuntime] freshness wait aborted: ${reason}`);
}

/**
 * 创建刷新门禁实例，通过版本号协调缓存刷新与异步等待。
 * 默认行为：无参数，初始 currentVersion 与 staleVersion 均为 0。
 *
 * @returns RefreshGate 实例（markStale、markFresh、waitForFresh、abortWaiting、resetAbort、getStatus）
 */
export function createRefreshGate(): RefreshGate {
  let currentVersion = 0;
  let staleVersion = 0;
  let abortReason: RefreshGateAbortReason | null = null;
  let waiters: Waiter[] = [];

  /**
   * 当门禁已恢复 freshness 时唤醒所有等待者。
   * @returns 无返回值
   */
  function resolveWaitersIfFresh(): void {
    if (currentVersion < staleVersion || waiters.length === 0) {
      return;
    }

    const pending = waiters;
    waiters = [];
    for (const waiter of pending) {
      waiter.resolve();
    }
  }

  function rejectWaiters(reason: unknown): void {
    if (waiters.length === 0) {
      return;
    }

    const pending = waiters;
    waiters = [];
    for (const waiter of pending) {
      waiter.reject(reason);
    }
  }

  /**
   * 标记当前状态为 stale，并返回本次 stale 版本号。
   * @returns 新的 staleVersion
   */
  function markStale(): number {
    if (abortReason !== null) {
      throw new Error(`[refreshGate] cannot mark stale while aborted: ${abortReason}`);
    }

    staleVersion += 1;
    return staleVersion;
  }

  /**
   * 将指定版本标记为 fresh，并尝试唤醒等待者。
   * @param version 完成刷新的版本号
   * @returns 无返回值
   */
  function markFresh(version: number): void {
    if (abortReason !== null) {
      throw new Error(`[refreshGate] cannot mark fresh while aborted: ${abortReason}`);
    }

    if (version > currentVersion) {
      currentVersion = version;
    }

    resolveWaitersIfFresh();
  }

  /**
   * 等待门禁恢复 fresh。
   * @returns 当 currentVersion >= staleVersion 时 resolve 的 Promise
   */
  function waitForFresh(): Promise<void> {
    if (abortReason !== null) {
      return Promise.reject(createAbortError(abortReason));
    }

    if (currentVersion >= staleVersion) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      waiters.push({ resolve, reject });
    });
  }

  function abortWaiting(reason: RefreshGateAbortReason): void {
    abortReason = reason;
    rejectWaiters(createAbortError(reason));
  }

  function resetAbort(): void {
    abortReason = null;
  }

  /**
   * 读取门禁当前版本状态。
   * @returns 包含 currentVersion 与 staleVersion 的快照
   */
  function getStatus(): RefreshGateStatus {
    return {
      currentVersion,
      staleVersion,
      abortReason,
    };
  }

  return {
    markStale,
    markFresh,
    waitForFresh,
    abortWaiting,
    resetAbort,
    getStatus,
  };
}

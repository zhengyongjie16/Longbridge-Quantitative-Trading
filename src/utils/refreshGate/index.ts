import type { RefreshGate, RefreshGateStatus, Waiter } from '../types.js';

/**
 * 创建刷新门禁实例，通过版本号协调缓存刷新与异步等待。
 * 默认行为：无参数，初始 currentVersion 与 staleVersion 均为 0。
 *
 * @returns RefreshGate 实例（markStale、markFresh、waitForFresh、getStatus）
 */
export function createRefreshGate(): RefreshGate {
  let currentVersion = 0;
  let staleVersion = 0;
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
    for (const resolve of pending) {
      resolve();
    }
  }

  /**
   * 标记当前状态为 stale，并返回本次 stale 版本号。
   * @returns 新的 staleVersion
   */
  function markStale(): number {
    staleVersion += 1;
    return staleVersion;
  }

  /**
   * 将指定版本标记为 fresh，并尝试唤醒等待者。
   * @param version 完成刷新的版本号
   * @returns 无返回值
   */
  function markFresh(version: number): void {
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
    if (currentVersion >= staleVersion) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      waiters.push(resolve);
    });
  }

  /**
   * 读取门禁当前版本状态。
   * @returns 包含 currentVersion 与 staleVersion 的快照
   */
  function getStatus(): RefreshGateStatus {
    return {
      currentVersion,
      staleVersion,
    };
  }

  return {
    markStale,
    markFresh,
    waitForFresh,
    getStatus,
  };
}

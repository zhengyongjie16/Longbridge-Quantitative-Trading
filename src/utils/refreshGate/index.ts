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

  function markStale(): number {
    staleVersion += 1;
    return staleVersion;
  }

  function markFresh(version: number): void {
    if (version > currentVersion) {
      currentVersion = version;
    }

    resolveWaitersIfFresh();
  }

  function waitForFresh(): Promise<void> {
    if (currentVersion >= staleVersion) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      waiters.push(resolve);
    });
  }

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

/**
 * 刷新门禁模块
 *
 * 功能：
 * - 通过版本号机制保证缓存新鲜度
 * - 防止异步处理器使用过期的持仓/账户缓存
 * - 在订单成交后标记缓存过期，刷新完成后标记为最新
 *
 * 核心机制：
 * - staleVersion：缓存过期版本（标记"需要刷新"时递增）
 * - currentVersion：已完成刷新版本（刷新成功后更新）
 * - waitForFresh()：等待缓存刷新完成（异步处理器调用）
 *
 * 使用场景：
 * - 订单成交后：调用 markStale() 标记缓存过期
 * - 刷新完成后：调用 markFresh(version) 标记为最新
 * - 异步处理器：在读取持仓/账户前调用 waitForFresh() 等待刷新
 */
import type { RefreshGate, RefreshGateStatus, Waiter } from './types.js';

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

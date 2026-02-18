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

  /**
   * 若缓存已是最新（currentVersion >= staleVersion），唤醒所有挂起的等待者
   * 批量 resolve 后清空 waiters，避免重复唤醒
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
   * 标记缓存过期，递增 staleVersion 并返回新版本号
   * 调用方应保存返回值，后续调用 markFresh(version) 时传入
   */
  function markStale(): number {
    staleVersion += 1;
    return staleVersion;
  }

  /**
   * 标记指定版本已刷新完成，更新 currentVersion 并尝试唤醒等待者
   * 仅当 version > currentVersion 时才更新，防止乱序刷新回退版本号
   */
  function markFresh(version: number): void {
    if (version > currentVersion) {
      currentVersion = version;
    }

    resolveWaitersIfFresh();
  }

  /**
   * 等待缓存刷新完成后继续执行
   * 若当前已是最新则立即 resolve；否则将 resolve 挂入 waiters，由 markFresh 触发唤醒
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
   * 返回当前版本号状态快照，用于外部观测刷新进度
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

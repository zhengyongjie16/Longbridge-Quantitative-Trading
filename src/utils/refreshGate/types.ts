/**
 * 刷新门禁类型定义模块
 *
 * 定义刷新门禁相关的类型：
 * - RefreshGateStatus：刷新门禁状态（版本号信息）
 * - RefreshGate：刷新门禁接口
 */

export type RefreshGateStatus = Readonly<{
  currentVersion: number;
  staleVersion: number;
}>;

export type RefreshGate = Readonly<{
  markStale: () => number;
  markFresh: (version: number) => void;
  waitForFresh: () => Promise<void>;
  getStatus: () => RefreshGateStatus;
}>;

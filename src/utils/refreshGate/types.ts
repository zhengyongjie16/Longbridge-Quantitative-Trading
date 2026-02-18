/**
 * 等待者回调函数类型
 * 用途：表示在 RefreshGate 中排队等待缓存刷新完成的回调函数签名
 * 数据来源：由 waitForFresh() 内部创建并推入等待队列
 * 使用范围：仅限 refreshGate 模块内部使用
 */
export type Waiter = () => void;

/**
 * 刷新门禁状态快照
 * 由 getStatus() 返回，用于外部观测当前版本号与过期版本号的差值
 */
export type RefreshGateStatus = Readonly<{
  currentVersion: number;
  staleVersion: number;
}>;

/**
 * 刷新门禁接口
 * 通过版本号机制协调缓存刷新与异步处理器之间的时序：
 * - markStale()：标记缓存过期，返回新版本号
 * - markFresh(version)：标记指定版本已刷新完成，唤醒等待者
 * - waitForFresh()：等待缓存刷新完成后继续执行
 * - getStatus()：获取当前版本号状态快照
 */
export interface RefreshGate {
  readonly markStale: () => number;
  readonly markFresh: (version: number) => void;
  readonly waitForFresh: () => Promise<void>;
  readonly getStatus: () => RefreshGateStatus;
}

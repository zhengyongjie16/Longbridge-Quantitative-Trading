/**
 * 等待者回调函数类型。
 * 类型用途：表示在 RefreshGate 中排队等待缓存刷新完成时的回调函数签名。
 * 数据来源：由 waitForFresh() 内部创建并推入等待队列。
 * 使用范围：仅 refreshGate 模块内部使用。
 */
export type Waiter = () => void;

/**
 * 刷新门禁状态快照。
 * 类型用途：表示当前版本与过期版本号，用于协调缓存刷新与等待方。
 * 数据来源：由 RefreshGate.getStatus() 返回。
 * 使用范围：供主程序与 PostTradeRefresher 等消费 getStatus 的调用方使用。
 */
export type RefreshGateStatus = Readonly<{
  currentVersion: number;
  staleVersion: number;
}>;

/**
 * 刷新门禁接口。
 * 类型用途：依赖注入用接口，通过版本号协调缓存刷新与异步处理器时序（markStale/markFresh/waitForFresh/getStatus），供主程序与 PostTradeRefresher 等使用。
 * 数据来源：由 createRefreshGate 等工厂实现并注入。
 * 使用范围：主程序、PostTradeRefresher、门禁逻辑等；全项目可引用。
 */
export interface RefreshGate {
  readonly markStale: () => number;
  readonly markFresh: (version: number) => void;
  readonly waitForFresh: () => Promise<void>;
  readonly getStatus: () => RefreshGateStatus;
}

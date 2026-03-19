/**
 * 订单监控 Worker 依赖（创建 OrderMonitorWorker 时的参数）。
 * 类型用途：createOrderMonitorWorker 的依赖注入，提供 monitorAndManageOrders 等能力。
 * 数据来源：由主程序/启动流程组装并传入工厂。
 * 使用范围：仅 orderMonitorWorker 及启动流程使用，内部使用。
 */
export type OrderMonitorWorkerDeps = Readonly<{
  monitorAndManageOrders: () => Promise<void>;
}>;

/**
 * 订单监控 Worker 行为契约。
 * 类型用途：主循环触发异步执行订单监控与管理（schedule/stopAndDrain）。
 * 数据来源：主程序通过 createOrderMonitorWorker 创建并持有，schedule 只表示“需要再跑一次”。
 * 使用范围：mainProgram 持有并调用，仅内部使用。
 */
export interface OrderMonitorWorker {
  readonly start: () => void;
  readonly schedule: () => void;
  readonly stopAndDrain: () => Promise<void>;
}

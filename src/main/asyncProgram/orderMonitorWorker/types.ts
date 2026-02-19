import type { Quote } from '../../../types/quote.js';

/**
 * 订单监控 Worker 依赖（创建 OrderMonitorWorker 时的参数）。
 * 类型用途：createOrderMonitorWorker 的依赖注入，提供 monitorAndManageOrders 等能力。
 * 数据来源：由主程序/启动流程组装并传入工厂。
 * 使用范围：仅 orderMonitorWorker 及启动流程使用，内部使用。
 */
export type OrderMonitorWorkerDeps = Readonly<{
  monitorAndManageOrders: (quotesMap: ReadonlyMap<string, Quote | null>) => Promise<void>;
}>;

/**
 * 订单监控 Worker 行为契约。
 * 类型用途：主循环传入行情后异步执行订单监控与管理（schedule/stopAndDrain/clearLatestQuotes）。
 * 数据来源：主程序通过 createOrderMonitorWorker 创建并持有，schedule 的行情来自主循环 quotesMap。
 * 使用范围：mainProgram 持有并调用，仅内部使用。
 */
export interface OrderMonitorWorker {
  readonly start: () => void;
  readonly schedule: (quotesMap: ReadonlyMap<string, Quote | null>) => void;
  readonly stopAndDrain: () => Promise<void>;
  readonly clearLatestQuotes: () => void;
}

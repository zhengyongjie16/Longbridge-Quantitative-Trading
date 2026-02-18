import type { Quote } from '../../../types/quote.js';

/**
 * OrderMonitorWorker 依赖注入配置
 *
 * 创建订单监控 Worker 所需的外部依赖，
 * 仅供 createOrderMonitorWorker 工厂函数使用。
 */
export type OrderMonitorWorkerDeps = Readonly<{
  monitorAndManageOrders: (quotesMap: ReadonlyMap<string, Quote | null>) => Promise<void>;
}>;

/**
 * 订单监控 Worker 行为契约
 *
 * 负责在后台异步轮询订单状态，接收行情快照后触发订单管理逻辑。
 * 支持启动、调度、优雅排空和行情清除操作。
 */
export interface OrderMonitorWorker {
  readonly start: () => void;
  readonly schedule: (quotesMap: ReadonlyMap<string, Quote | null>) => void;
  readonly stopAndDrain: () => Promise<void>;
  readonly clearLatestQuotes: () => void;
}

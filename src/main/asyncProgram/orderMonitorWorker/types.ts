/**
 * 订单监控工作器类型定义
 *
 * 定义订单监控工作器相关的类型：
 * - OrderMonitorWorkerDeps：依赖注入（订单监控函数）
 * - OrderMonitorWorker：工作器接口
 */
import type { Quote } from '../../../types/quote.js';

export type OrderMonitorWorkerDeps = Readonly<{
  monitorAndManageOrders: (quotesMap: ReadonlyMap<string, Quote | null>) => Promise<void>;
}>;

export interface OrderMonitorWorker {
  readonly start: () => void;
  readonly schedule: (quotesMap: ReadonlyMap<string, Quote | null>) => void;
  readonly stopAndDrain: () => Promise<void>;
  readonly clearLatestQuotes: () => void;
}

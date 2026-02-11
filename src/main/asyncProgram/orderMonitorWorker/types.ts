/**
 * 订单监控工作器类型定义
 *
 * 定义订单监控工作器相关的类型：
 * - OrderMonitorWorkerDeps：依赖注入（订单监控函数）
 * - OrderMonitorWorker：工作器接口
 */
import type { Quote } from '../../../types/index.js';

export type OrderMonitorWorkerDeps = Readonly<{
  monitorAndManageOrders: (quotesMap: ReadonlyMap<string, Quote | null>) => Promise<void>;
}>;

export type OrderMonitorWorker = Readonly<{
  start: () => void;
  schedule: (quotesMap: ReadonlyMap<string, Quote | null>) => void;
  stop: () => void;
  stopAndDrain: () => Promise<void>;
  clearLatestQuotes: () => void;
}>;

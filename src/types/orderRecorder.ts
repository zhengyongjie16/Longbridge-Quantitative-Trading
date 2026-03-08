import type { OrderRecord } from './services.js';

/**
 * 订单归属解析结果。
 * 类型用途：表示单笔 API 订单归属的监控标的与方向，供订单归属分析与当日亏损追踪共享。
 * 数据来源：订单归属解析逻辑根据订单名称与归属映射推导得到。
 * 使用范围：OrderRecorder、DailyLossTracker、订单恢复与诊断日志；全项目可引用。
 */
export type OrderOwnership = {
  readonly monitorSymbol: string;
  readonly direction: 'LONG' | 'SHORT';
};

/**
 * 订单过滤引擎接口。
 * 类型用途：抽象智能清仓与当日亏损计算共用的订单过滤算法。
 * 数据来源：由 orderRecorder 模块实现并注入。
 * 使用范围：OrderRecorder、DailyLossTracker 等需要未平仓买单计算的场景；全项目可引用。
 */
export interface OrderFilteringEngine {
  applyFilteringAlgorithm: (
    allBuyOrders: ReadonlyArray<OrderRecord>,
    filledSellOrders: ReadonlyArray<OrderRecord>,
  ) => ReadonlyArray<OrderRecord>;
}

/**
 * DoomsdayProtection 模块类型定义
 */

import type { Position, MonitorConfig, MonitorContext, Trader, MarketDataClient, LastState } from '../../types/index.js';

/**
 * 末日保护执行上下文
 */
export type DoomsdayClearanceContext = {
  readonly currentTime: Date;
  readonly isHalfDay: boolean;
  readonly positions: ReadonlyArray<Position>;
  readonly monitorConfigs: ReadonlyArray<MonitorConfig>;
  readonly monitorContexts: ReadonlyMap<string, MonitorContext>;
  readonly trader: Trader;
  readonly marketDataClient: MarketDataClient;
  readonly lastState: LastState;
};

/**
 * 末日保护执行结果
 */
export type DoomsdayClearanceResult = {
  readonly executed: boolean;
  readonly signalCount: number;
};

/**
 * 撤销买入订单上下文
 */
export type CancelPendingBuyOrdersContext = {
  readonly currentTime: Date;
  readonly isHalfDay: boolean;
  readonly monitorConfigs: ReadonlyArray<MonitorConfig>;
  readonly trader: Trader;
};

/**
 * 撤销买入订单结果
 */
export type CancelPendingBuyOrdersResult = {
  readonly executed: boolean;
  readonly cancelledCount: number;
};

/**
 * 末日保护程序接口
 * 在收盘前执行保护性操作：
 * - 收盘前15分钟拒绝买入
 * - 收盘前15分钟撤销所有未成交的买入订单
 * - 收盘前5分钟自动清仓
 */
export interface DoomsdayProtection {
  /**
   * 检查是否应该拒绝买入（收盘前15分钟）
   * @param currentTime 当前时间
   * @param isHalfDay 是否是半日交易日
   * @returns true表示应该拒绝买入
   */
  shouldRejectBuy(currentTime: Date, isHalfDay: boolean): boolean;

  /**
   * 执行末日保护清仓流程
   * 包括：收集标的、获取行情、生成信号、去重、执行清仓、清空订单记录
   * @param context 执行上下文
   * @returns 执行结果
   */
  executeClearance(context: DoomsdayClearanceContext): Promise<DoomsdayClearanceResult>;

  /**
   * 撤销所有未成交的买入订单（收盘前15分钟）
   * @param context 撤单上下文
   * @returns 撤单结果
   */
  cancelPendingBuyOrders(context: CancelPendingBuyOrdersContext): Promise<CancelPendingBuyOrdersResult>;
}

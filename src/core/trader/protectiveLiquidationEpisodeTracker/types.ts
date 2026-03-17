/**
 * 保护性清仓事件方向。
 * 类型用途：按 monitorSymbol + direction 隔离保护性清仓事件状态。
 * 数据来源：订单归属解析与风控链路。
 * 使用范围：protectiveLiquidationEpisodeTracker 及其调用方。
 */
export type ProtectiveLiquidationDirection = 'LONG' | 'SHORT';

/**
 * 记录保护性清仓成交进度参数。
 * 类型用途：在保护性清仓订单产生真实成交后更新该事件最新成交时间。
 * 数据来源：settlementFlow 成交结算链路。
 * 使用范围：protectiveLiquidationEpisodeTracker。
 */
export type RecordProtectiveFillProgressParams = Readonly<{
  monitorSymbol: string;
  direction: ProtectiveLiquidationDirection;
  executedTimeMs: number;
}>;

/**
 * 保护性清仓完成确认参数。
 * 类型用途：在持仓刷新后基于“空仓 + 无未完成保护性卖单”判定事件完成。
 * 数据来源：postTradeRefresher。
 * 使用范围：protectiveLiquidationEpisodeTracker。
 */
export type CompleteIfEligibleParams = Readonly<{
  monitorSymbol: string;
  direction: ProtectiveLiquidationDirection;
  isDirectionFlat: boolean;
  hasPendingProtectiveOrders: boolean;
}>;

/**
 * 保护性清仓完成事件。
 * 类型用途：向上游发布“当前事件完成且边界可推进”的单次事件。
 * 数据来源：protectiveLiquidationEpisodeTracker.completeIfEligible。
 * 使用范围：postTradeRefresher、dailyLossTracker、liquidationCooldownTracker。
 */
export type ProtectiveLiquidationCompletedEvent = Readonly<{
  monitorSymbol: string;
  direction: ProtectiveLiquidationDirection;
  boundaryExecutedTimeMs: number;
}>;

/**
 * 恢复已完成边界参数。
 * 类型用途：启动恢复时写入最近一次已完成保护性清仓边界。
 * 数据来源：loadTradingDayRuntimeSnapshot。
 * 使用范围：protectiveLiquidationEpisodeTracker。
 */
export type RestoreCompletedBoundaryParams = Readonly<{
  monitorSymbol: string;
  direction: ProtectiveLiquidationDirection;
  boundaryExecutedTimeMs: number;
}>;

/**
 * 恢复进行中事件参数。
 * 类型用途：启动恢复时写入已发生但未完成的保护性清仓最新成交进度。
 * 数据来源：loadTradingDayRuntimeSnapshot。
 * 使用范围：protectiveLiquidationEpisodeTracker。
 */
export type RestoreInProgressEpisodeParams = Readonly<{
  monitorSymbol: string;
  direction: ProtectiveLiquidationDirection;
  latestExecutedTimeMs: number;
}>;

/**
 * 进行中的保护性清仓事件快照。
 * 类型用途：供 postTradeRefresher 扫描完成判定。
 * 数据来源：protectiveLiquidationEpisodeTracker 运行态。
 * 使用范围：postTradeRefresher。
 */
export type InProgressProtectiveEpisode = Readonly<{
  monitorSymbol: string;
  direction: ProtectiveLiquidationDirection;
  latestExecutedTimeMs: number;
}>;

/**
 * 保护性清仓事件跟踪器接口。
 * 类型用途：集中管理保护性清仓进行中事件和已完成边界，保证单次事件只完成一次。
 * 数据来源：createProtectiveLiquidationEpisodeTracker 工厂创建。
 * 使用范围：orderMonitor、postTradeRefresher、lifecycle 恢复链路。
 */
export interface ProtectiveLiquidationEpisodeTracker {
  recordProtectiveFillProgress: (params: RecordProtectiveFillProgressParams) => void;
  completeIfEligible: (
    params: CompleteIfEligibleParams,
  ) => ProtectiveLiquidationCompletedEvent | null;
  restoreCompletedBoundary: (params: RestoreCompletedBoundaryParams) => void;
  restoreInProgressEpisode: (params: RestoreInProgressEpisodeParams) => void;
  getLatestProtectionBoundaryByDirection: () => ReadonlyMap<string, number>;
  getInProgressEpisodes: () => ReadonlyArray<InProgressProtectiveEpisode>;
  resetAll: () => void;
}

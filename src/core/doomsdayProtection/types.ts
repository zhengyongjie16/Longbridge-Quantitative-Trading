import type { Position } from '../../types/account.js';
import type { MonitorConfig } from '../../types/config.js';
import type { MonitorContext, LastState } from '../../types/state.js';
import type { SignalType } from '../../types/signal.js';
import type { Trader, MarketDataClient } from '../../types/services.js';

/**
 * 清仓信号创建参数。
 * 类型用途：构造末日保护清仓信号时的参数。
 * 数据来源：模块内部根据持仓与行情构造。
 * 使用范围：仅 doomsdayProtection 模块内部使用。
 */
export type ClearanceSignalParams = {
  readonly symbol: string;
  readonly symbolName: string | null;
  readonly action: SignalType;
  readonly price: number | null;
  readonly lotSize: number | null;
  readonly positionType: 'long' | 'short';
};

/**
 * 末日保护执行上下文。
 * 类型用途：executeClearance 的入参，封装清仓流程所需的依赖与状态。
 * 数据来源：主程序/调用方传入。
 * 使用范围：仅 doomsdayProtection 模块使用。
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
 * 末日保护执行结果。
 * 类型用途：DoomsdayProtection.executeClearance 的返回结果。
 * 数据来源：由 DoomsdayProtection.executeClearance 返回。
 * 使用范围：见调用方。
 */
export type DoomsdayClearanceResult = {
  readonly executed: boolean;
  readonly signalCount: number;
};

/**
 * 撤销买入订单上下文。
 * 类型用途：cancelPendingBuyOrders 的入参，封装撤单流程所需的依赖与状态。
 * 数据来源：主程序/调用方传入。
 * 使用范围：仅 doomsdayProtection 模块使用。
 */
export type CancelPendingBuyOrdersContext = {
  readonly currentTime: Date;
  readonly isHalfDay: boolean;
  readonly monitorConfigs: ReadonlyArray<MonitorConfig>;
  readonly monitorContexts: ReadonlyMap<string, MonitorContext>;
  readonly trader: Trader;
};

/**
 * 撤销买入订单结果。
 * 类型用途：DoomsdayProtection.cancelPendingBuyOrders 的返回结果。
 * 数据来源：由 DoomsdayProtection.cancelPendingBuyOrders 返回。
 * 使用范围：见调用方。
 */
export type CancelPendingBuyOrdersResult = {
  readonly executed: boolean;
  readonly cancelledCount: number;
};

/**
 * 末日保护程序接口。
 * 类型用途：依赖注入的服务接口，在收盘前执行保护性操作（拒绝买入、撤单、清仓）。
 * 数据来源：如适用。
 * 使用范围：主程序持有并调用；仅 doomsdayProtection 模块实现。
 */
export interface DoomsdayProtection {
  /**
   * 检查是否应该拒绝买入（收盘前15分钟）
   * @param currentTime 当前时间
   * @param isHalfDay 是否是半日交易日
   * @returns true表示应该拒绝买入
   */
  shouldRejectBuy: (currentTime: Date, isHalfDay: boolean) => boolean;

  /**
   * 执行末日保护清仓流程
   * 包括：收集标的、获取行情、生成信号、去重、执行清仓、清空订单记录
   * @param context 执行上下文
   * @returns 执行结果
   */
  executeClearance: (context: DoomsdayClearanceContext) => Promise<DoomsdayClearanceResult>;

  /**
   * 撤销所有未成交的买入订单（收盘前15分钟）
   * @param context 撤单上下文
   * @returns 撤单结果
   */
  cancelPendingBuyOrders: (
    context: CancelPendingBuyOrdersContext,
  ) => Promise<CancelPendingBuyOrdersResult>;
}

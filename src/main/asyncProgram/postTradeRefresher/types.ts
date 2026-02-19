import type { LastState, MonitorContext } from '../../../types/state.js';
import type { Quote } from '../../../types/quote.js';
import type { PendingRefreshSymbol, Trader } from '../../../types/services.js';
import type { RefreshGate } from '../../../utils/refreshGate/types.js';

/**
 * 交易后刷新器入队参数（enqueue 的入参）。
 * 类型用途：订单成交后调用方传入，包含待刷新标的列表与当前行情快照，用于异步刷新账户/持仓/浮亏。
 * 数据来源：由订单成交回调（如 tradeLogger/trader 侧）在成交后组装并调用 enqueue 传入。
 * 使用范围：仅 postTradeRefresher 及调用 enqueue 的模块使用，内部使用。
 */
export type PostTradeRefresherEnqueueParams = Readonly<{
  pending: ReadonlyArray<PendingRefreshSymbol>;
  quotesMap: ReadonlyMap<string, Quote | null>;
}>;

/**
 * 交易后刷新器依赖注入配置（创建 PostTradeRefresher 时的参数）。
 * 类型用途：创建 PostTradeRefresher 所需的全部外部依赖（refreshGate、trader、lastState、monitorContexts、displayAccountAndPositions）。
 * 数据来源：由主程序/启动流程组装并传入工厂。
 * 使用范围：仅 postTradeRefresher 及启动流程使用，内部使用。
 */
export type PostTradeRefresherDeps = Readonly<{
  refreshGate: RefreshGate;
  trader: Trader;
  lastState: LastState;
  monitorContexts: ReadonlyMap<string, MonitorContext>;
  displayAccountAndPositions: (params: {
    lastState: LastState;
    quotesMap: ReadonlyMap<string, Quote | null>;
  }) => Promise<void>;
}>;

/**
 * 交易后刷新器行为契约。
 * 类型用途：订单成交后异步刷新账户、持仓与浮亏数据，并通过 RefreshGate 通知其他处理器缓存已更新（start/enqueue/stopAndDrain/clearPending）。
 * 数据来源：主程序通过工厂创建并持有，enqueue 由成交回调触发。
 * 使用范围：mainProgram、lifecycle 等持有并调用，仅内部使用。
 */
export interface PostTradeRefresher {
  readonly start: () => void;
  readonly enqueue: (params: PostTradeRefresherEnqueueParams) => void;
  readonly stopAndDrain: () => Promise<void>;
  readonly clearPending: () => void;
}

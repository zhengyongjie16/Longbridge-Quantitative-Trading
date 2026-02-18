import type { LastState, MonitorContext } from '../../../types/state.js';
import type { Quote } from '../../../types/quote.js';
import type { PendingRefreshSymbol, Trader } from '../../../types/services.js';
import type { RefreshGate } from '../../../utils/refreshGate/types.js';

/**
 * 交易后刷新器入队参数
 *
 * 订单成交后由调用方传入，包含待刷新的标的列表和当前行情快照。
 */
export type PostTradeRefresherEnqueueParams = Readonly<{
  pending: ReadonlyArray<PendingRefreshSymbol>;
  quotesMap: ReadonlyMap<string, Quote | null>;
}>;

/**
 * 交易后刷新器依赖注入配置
 *
 * 创建 PostTradeRefresher 所需的全部外部依赖，通过工厂函数注入。
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
 * 交易后刷新器行为契约
 *
 * 负责订单成交后异步刷新账户、持仓和浮亏数据，
 * 并通过 RefreshGate 通知其他处理器缓存已更新。
 */
export interface PostTradeRefresher {
  readonly start: () => void;
  readonly enqueue: (params: PostTradeRefresherEnqueueParams) => void;
  readonly stopAndDrain: () => Promise<void>;
  readonly clearPending: () => void;
}

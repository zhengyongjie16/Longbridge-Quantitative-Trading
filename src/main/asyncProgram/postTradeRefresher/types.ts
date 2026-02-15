/**
 * 交易后刷新器类型定义
 *
 * 定义交易后刷新器相关的类型：
 * - PostTradeRefresherEnqueueParams：入队参数（待刷新标的列表和行情）
 * - PostTradeRefresherDeps：依赖注入
 * - PostTradeRefresher：刷新器接口
 */
import type { LastState, MonitorContext } from '../../../types/state.js';
import type { Quote } from '../../../types/quote.js';
import type { PendingRefreshSymbol, Trader } from '../../../types/services.js';
import type { RefreshGate } from '../../../utils/refreshGate/types.js';

export type PostTradeRefresherEnqueueParams = Readonly<{
  pending: ReadonlyArray<PendingRefreshSymbol>;
  quotesMap: ReadonlyMap<string, Quote | null>;
}>;

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

export interface PostTradeRefresher {
  readonly start: () => void;
  readonly enqueue: (params: PostTradeRefresherEnqueueParams) => void;
  readonly stopAndDrain: () => Promise<void>;
  readonly clearPending: () => void;
}

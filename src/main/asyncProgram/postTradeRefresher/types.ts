/**
 * 交易后刷新器类型定义
 *
 * 定义交易后刷新器相关的类型：
 * - PostTradeRefresherEnqueueParams：入队参数（待刷新标的列表和行情）
 * - PostTradeRefresherDeps：依赖注入
 * - PostTradeRefresher：刷新器接口
 */
import type { LastState, MonitorContext, PendingRefreshSymbol, Quote, Trader } from '../../../types/index.js';
import type { RefreshGate } from '../../../utils/refreshGate/types.js';

export type PostTradeRefresherEnqueueParams = Readonly<{
  pending: ReadonlyArray<PendingRefreshSymbol>;
  quotesMap: ReadonlyMap<string, Quote | null>;
}>;

export type PostTradeRefresherDeps = Readonly<{
  readonly refreshGate: RefreshGate;
  readonly trader: Trader;
  readonly lastState: LastState;
  readonly monitorContexts: ReadonlyMap<string, MonitorContext>;
  readonly displayAccountAndPositions: (params: {
    lastState: LastState;
    quotesMap: ReadonlyMap<string, Quote | null>;
  }) => Promise<void>;
}>;

export type PostTradeRefresher = Readonly<{
  start: () => void;
  enqueue: (params: PostTradeRefresherEnqueueParams) => void;
  stop: () => void;
  stopAndDrain: () => Promise<void>;
  clearPending: () => void;
}>;

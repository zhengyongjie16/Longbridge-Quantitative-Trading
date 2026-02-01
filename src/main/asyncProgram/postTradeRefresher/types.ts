import type { LastState, MonitorContext, PendingRefreshSymbol, Quote, Trader } from '../../../types/index.js';
import type { RefreshGate } from '../../../utils/refreshGate/types.js';

export type PostTradeRefresherEnqueueParams = Readonly<{
  pending: ReadonlyArray<PendingRefreshSymbol>;
  quotesMap: ReadonlyMap<string, Quote | null>;
}>;

export type DisplayAccountAndPositions = (params: {
  lastState: LastState;
  quotesMap: ReadonlyMap<string, Quote | null>;
}) => Promise<void>;

export type PostTradeRefresherDeps = Readonly<{
  readonly refreshGate: RefreshGate;
  readonly trader: Trader;
  readonly lastState: LastState;
  readonly monitorContexts: ReadonlyMap<string, MonitorContext>;
  readonly displayAccountAndPositions: DisplayAccountAndPositions;
}>;

export type PostTradeRefresher = Readonly<{
  enqueue: (params: PostTradeRefresherEnqueueParams) => void;
  stop: () => void;
}>;

import type { OrderType } from 'longport';
import type { PendingSellOrderSnapshot } from '../types.js';

export type SellMergeDecisionAction = 'SUBMIT' | 'REPLACE' | 'CANCEL_AND_SUBMIT' | 'SKIP';

export type SellMergeDecisionInput = {
  readonly symbol: string;
  readonly pendingOrders: ReadonlyArray<PendingSellOrderSnapshot>;
  readonly newOrderQuantity: number;
  readonly newOrderPrice: number | null;
  readonly newOrderType: typeof OrderType[keyof typeof OrderType];
  readonly isProtectiveLiquidation: boolean;
};

export type SellMergeDecision = {
  readonly action: SellMergeDecisionAction;
  readonly mergedQuantity: number;
  readonly targetOrderId: string | null;
  readonly price: number | null;
  readonly pendingOrderIds: ReadonlyArray<string>;
  readonly pendingRemainingQuantity: number;
  readonly reason:
    | 'no-additional-quantity'
    | 'no-pending-sell'
    | 'cancel-and-merge'
    | 'replace-and-merge';
};

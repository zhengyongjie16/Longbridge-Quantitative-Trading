import type { QuoteContext, WarrantStatus, WarrantType } from 'longport';
import type { DecimalLike } from '../../utils/helpers/types.js';
import type { Logger } from '../../utils/logger/types.js';

export type FindBestWarrantInput = {
  readonly ctx: QuoteContext;
  readonly monitorSymbol: string;
  readonly isBull: boolean;
  readonly tradingMinutes: number;
  readonly minPrice: number;
  readonly minTurnoverPerMinute: number;
  readonly expiryMinMonths: number;
  readonly logger: Logger;
};

export type WarrantListItem = {
  readonly symbol: string;
  readonly name?: string | null;
  readonly lastDone: DecimalLike | number | string | null | undefined;
  readonly turnover: DecimalLike | number | string | null | undefined;
  readonly warrantType: WarrantType | number | string | null | undefined;
  readonly status: WarrantStatus | number | string | null | undefined;
};

export type SelectBestWarrantInput = {
  readonly warrants: ReadonlyArray<WarrantListItem>;
  readonly tradingMinutes: number;
  readonly minPrice: number;
  readonly minTurnoverPerMinute: number;
};

export type WarrantCandidate = {
  readonly symbol: string;
  readonly name: string | null;
  readonly price: number;
  readonly turnover: number;
  readonly turnoverPerMinute: number;
};

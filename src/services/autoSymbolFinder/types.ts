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
  readonly cacheConfig?: WarrantListCacheConfig;
};

export type WarrantListItem = {
  readonly symbol: string;
  readonly name?: string | null;
  readonly lastDone: DecimalLike | number | string | null | undefined;
  readonly turnover: DecimalLike | number | string | null | undefined;
  readonly warrantType: WarrantType | number | string | null | undefined;
  readonly status: WarrantStatus | number | string | null | undefined;
};

export type WarrantListCacheEntry = {
  readonly fetchedAt: number;
  readonly warrants: ReadonlyArray<WarrantListItem>;
};

export type WarrantListCache = {
  readonly entries: Map<string, WarrantListCacheEntry>;
  readonly inFlight: Map<string, Promise<ReadonlyArray<WarrantListItem>>>;
};

export type WarrantListCacheConfig = {
  readonly cache: WarrantListCache;
  readonly ttlMs: number;
  readonly nowMs: () => number;
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

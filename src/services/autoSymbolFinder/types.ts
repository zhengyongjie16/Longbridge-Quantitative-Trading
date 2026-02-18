import type {
  FilterWarrantExpiryDate,
  QuoteContext,
  WarrantStatus,
  WarrantType,
} from 'longport';
import type { DecimalLike } from '../../utils/helpers/types.js';
import type { Logger } from '../../utils/logger/types.js';

/**
 * 寻找最佳牛熊证的入参，包含行情上下文、筛选阈值与缓存配置。
 * 由 autoSymbolFinder/index.ts 的 findBestWarrant 消费。
 */
export type FindBestWarrantInput = {
  readonly ctx: QuoteContext;
  readonly monitorSymbol: string;
  readonly isBull: boolean;
  readonly tradingMinutes: number;
  readonly minDistancePct: number;
  readonly minTurnoverPerMinute: number;
  readonly expiryMinMonths: number;
  readonly logger: Logger;
  readonly cacheConfig?: WarrantListCacheConfig;
};

/**
 * 牛熊证列表单项数据，来源于 LongPort warrantList API 返回值。
 * 仅在 autoSymbolFinder 模块内部使用。
 */
export type WarrantListItem = {
  readonly symbol: string;
  readonly name?: string | null;
  readonly lastDone: DecimalLike | number | string | null | undefined;
  readonly toCallPrice: DecimalLike | number | string | null | undefined;
  readonly callPrice?: DecimalLike | number | string | null | undefined;
  readonly turnover: DecimalLike | number | string | null | undefined;
  readonly warrantType: WarrantType | number | string | null | undefined;
  readonly status: WarrantStatus | number | string | null | undefined;
};

/**
 * 牛熊证列表缓存条目，记录获取时间与数据，用于 TTL 过期判断。
 * 仅在 autoSymbolFinder 模块内部使用。
 */
export type WarrantListCacheEntry = {
  readonly fetchedAt: number;
  readonly warrants: ReadonlyArray<WarrantListItem>;
};

/**
 * 牛熊证列表缓存接口，支持 TTL 缓存与请求去重（inFlight）。
 * 由 createWarrantListCache 工厂函数实现，仅在 autoSymbolFinder 模块内部使用。
 */
export interface WarrantListCache {
  getEntry(key: string): WarrantListCacheEntry | undefined;
  setEntry(key: string, entry: WarrantListCacheEntry): void;
  getInFlight(key: string): Promise<ReadonlyArray<WarrantListItem>> | undefined;
  setInFlight(key: string, request: Promise<ReadonlyArray<WarrantListItem>>): void;
  deleteInFlight(key: string): void;
  clear(): void;
}

/**
 * 牛熊证列表缓存配置，包含缓存实例、TTL 时长与当前时间获取函数。
 * 由调用方传入 findBestWarrant，可选；不传则跳过缓存直接请求。
 */
export type WarrantListCacheConfig = {
  readonly cache: WarrantListCache;
  readonly ttlMs: number;
  readonly nowMs: () => number;
};

/**
 * selectBestWarrant 的入参，包含候选列表与筛选条件。
 * 仅在 autoSymbolFinder 模块内部使用。
 */
export type SelectBestWarrantInput = {
  readonly warrants: ReadonlyArray<WarrantListItem>;
  readonly tradingMinutes: number;
  readonly isBull: boolean;
  readonly minDistancePct: number;
  readonly minTurnoverPerMinute: number;
};

/**
 * 自动寻标筛选结果，包含最佳候选标的的代码、回收价与距离信息。
 * 由 findBestWarrant 返回，供 autoSymbolManager 消费。
 */
export type WarrantCandidate = {
  readonly symbol: string;
  readonly name: string | null;
  readonly callPrice: number;
  readonly distancePct: number;
  readonly turnover: number;
  readonly turnoverPerMinute: number;
};

/**
 * 请求牛熊证列表的入参（带缓存配置），在 fetchWarrantsWithCache 中使用。
 * 仅在 autoSymbolFinder 模块内部使用。
 */
export type WarrantListFetchParams = {
  readonly ctx: FindBestWarrantInput['ctx'];
  readonly monitorSymbol: string;
  readonly warrantType: WarrantType;
  readonly expiryFilters: ReadonlyArray<FilterWarrantExpiryDate>;
  readonly cacheConfig: WarrantListCacheConfig;
};

/**
 * 请求牛熊证列表的入参（无缓存），直接调用 LongPort warrantList API。
 * 仅在 autoSymbolFinder 模块内部使用。
 */
export type WarrantListRequestParams = {
  readonly ctx: FindBestWarrantInput['ctx'];
  readonly monitorSymbol: string;
  readonly warrantType: WarrantType;
  readonly expiryFilters: ReadonlyArray<FilterWarrantExpiryDate>;
};

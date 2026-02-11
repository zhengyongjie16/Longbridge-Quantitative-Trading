/**
 * 自动寻标模块类型定义
 *
 * 包含牛熊证筛选相关的类型定义：
 * - FindBestWarrantInput：寻找最佳牛熊证的输入参数
 * - WarrantListItem：牛熊证列表项
 * - WarrantListCache：牛熊证列表缓存结构
 * - WarrantCandidate：候选牛熊证（筛选结果）
 *
 * 缓存机制：
 * - 支持 TTL 缓存，避免频繁调用 API
 * - 支持请求去重（inFlight），防止并发请求
 */
import type {
  FilterWarrantExpiryDate,
  QuoteContext,
  WarrantStatus,
  WarrantType,
} from 'longport';
import type { DecimalLike } from '../../utils/helpers/types.js';
import type { Logger } from '../../utils/logger/types.js';

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
  readonly isBull: boolean;
  readonly minDistancePct: number;
  readonly minTurnoverPerMinute: number;
};

export type WarrantCandidate = {
  readonly symbol: string;
  readonly name: string | null;
  readonly callPrice: number;
  readonly distancePct: number;
  readonly turnover: number;
  readonly turnoverPerMinute: number;
};

/** 请求牛熊证列表的入参（带缓存配置） */
export type WarrantListFetchParams = {
  readonly ctx: FindBestWarrantInput['ctx'];
  readonly monitorSymbol: string;
  readonly warrantType: WarrantType;
  readonly expiryFilters: ReadonlyArray<FilterWarrantExpiryDate>;
  readonly cacheConfig: WarrantListCacheConfig;
};

/** 请求牛熊证列表的入参（无缓存） */
export type WarrantListRequestParams = {
  readonly ctx: FindBestWarrantInput['ctx'];
  readonly monitorSymbol: string;
  readonly warrantType: WarrantType;
  readonly expiryFilters: ReadonlyArray<FilterWarrantExpiryDate>;
};

import type {
  FilterWarrantExpiryDate,
  QuoteContext,
  WarrantStatus,
  WarrantType,
} from 'longport';
import type { DecimalLike } from '../../utils/helpers/types.js';
import type { Logger } from '../../utils/logger/types.js';

/**
 * 寻找最佳牛熊证的入参。
 * 类型用途：包含行情上下文、筛选阈值与缓存配置，由 findBestWarrant 消费。
 * 数据来源：由 autoSymbolManager 的 buildFindBestWarrantInput 等构造传入。
 * 使用范围：autoSymbolFinder 与 autoSymbolManager 模块使用。
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
 * 牛熊证列表单项数据。
 * 类型用途：表示单只牛熊证的行情与属性，供 selectBestWarrant 等筛选使用。
 * 数据来源：LongPort warrantList API 返回值结构映射。
 * 使用范围：仅 autoSymbolFinder 模块内部使用。
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
 * 牛熊证列表缓存条目。
 * 类型用途：记录获取时间与数据，用于 TTL 过期判断。
 * 数据来源：由 fetchWarrantsWithCache 写入缓存。
 * 使用范围：仅 autoSymbolFinder 模块内部使用。
 */
export type WarrantListCacheEntry = {
  readonly fetchedAt: number;
  readonly warrants: ReadonlyArray<WarrantListItem>;
};

/**
 * 牛熊证列表缓存接口。
 * 类型用途：支持 TTL 缓存与请求去重（inFlight），供 findBestWarrant 复用列表请求。
 * 数据来源：由 createWarrantListCache 工厂函数实现并注入。
 * 使用范围：仅 autoSymbolFinder 模块内部使用。
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
 * 牛熊证列表缓存配置。
 * 类型用途：包含缓存实例、TTL 时长与当前时间获取函数，供 findBestWarrant 可选使用。
 * 数据来源：由 autoSymbolManager 的 createThresholdResolver 等构造并传入。
 * 使用范围：autoSymbolFinder 与 autoSymbolManager 模块使用。
 */
export type WarrantListCacheConfig = {
  readonly cache: WarrantListCache;
  readonly ttlMs: number;
  readonly nowMs: () => number;
};

/**
 * selectBestWarrant 的入参。
 * 类型用途：包含候选列表与筛选条件（距回收价、分均成交额等），由 selectBestWarrant 消费。
 * 数据来源：由 findBestWarrant 内根据 API 返回列表与 FindBestWarrantInput 组装。
 * 使用范围：仅 autoSymbolFinder 模块内部使用。
 */
export type SelectBestWarrantInput = {
  readonly warrants: ReadonlyArray<WarrantListItem>;
  readonly tradingMinutes: number;
  readonly isBull: boolean;
  readonly minDistancePct: number;
  readonly minTurnoverPerMinute: number;
};

/**
 * 自动寻标筛选结果。
 * 类型用途：包含最佳候选标的的代码、回收价与距离信息，供换标/寻标流程绑定席位或下单使用。
 * 数据来源：由 findBestWarrant 内 selectBestWarrant 返回并封装。
 * 使用范围：autoSymbolFinder 返回，autoSymbolManager 消费。
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
 * 请求牛熊证列表的入参（带缓存配置）。
 * 类型用途：由 fetchWarrantsWithCache 消费，用于带缓存的 warrantList 请求。
 * 数据来源：由 findBestWarrant 内根据 FindBestWarrantInput 组装。
 * 使用范围：仅 autoSymbolFinder 模块内部使用。
 */
export type WarrantListFetchParams = {
  readonly ctx: FindBestWarrantInput['ctx'];
  readonly monitorSymbol: string;
  readonly warrantType: WarrantType;
  readonly expiryFilters: ReadonlyArray<FilterWarrantExpiryDate>;
  readonly cacheConfig: WarrantListCacheConfig;
};

/**
 * 请求牛熊证列表的入参（无缓存）。
 * 类型用途：直接调用 LongPort warrantList API 时的入参。
 * 数据来源：由 fetchWarrantsWithCache 或调用方组装。
 * 使用范围：仅 autoSymbolFinder 模块内部使用。
 */
export type WarrantListRequestParams = {
  readonly ctx: FindBestWarrantInput['ctx'];
  readonly monitorSymbol: string;
  readonly warrantType: WarrantType;
  readonly expiryFilters: ReadonlyArray<FilterWarrantExpiryDate>;
};

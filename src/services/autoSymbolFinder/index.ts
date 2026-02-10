/**
 * 自动寻标入口：从行情服务筛选合适的牛熊证。
 */
import {
  FilterWarrantInOutBoundsType,
  FilterWarrantExpiryDate,
  SortOrderType,
  WarrantSortBy,
  WarrantStatus,
  WarrantType,
} from 'longport';
import { formatError } from '../../utils/helpers/index.js';
import { buildExpiryDateFilters, selectBestWarrant } from './utils.js';
import type {
  FindBestWarrantInput,
  WarrantCandidate,
  WarrantListItem,
  WarrantListFetchParams,
  WarrantListRequestParams,
} from './types.js';

/** 构建缓存键：监控标的+牛熊类型+到期日筛选条件 */
function buildCacheKey(
  monitorSymbol: string,
  warrantType: WarrantType,
  expiryFilters: ReadonlyArray<FilterWarrantExpiryDate>,
): string {
  return `${monitorSymbol}:${String(warrantType)}:${expiryFilters.join(',')}`;
}

/** 调用 API 请求牛熊证列表 */
function requestWarrantList({
  ctx,
  monitorSymbol,
  warrantType,
  expiryFilters,
}: WarrantListRequestParams): Promise<ReadonlyArray<WarrantListItem>> {
  return ctx.warrantList(
    monitorSymbol,
    WarrantSortBy.Turnover,
    SortOrderType.Descending,
    [warrantType],
    null,
    [...expiryFilters],
    [FilterWarrantInOutBoundsType.In],
    [WarrantStatus.Normal],
  );
}

/** 带缓存的牛熊证列表获取，支持 TTL 和请求去重 */
async function fetchWarrantsWithCache({
  ctx,
  monitorSymbol,
  warrantType,
  expiryFilters,
  cacheConfig,
}: WarrantListFetchParams): Promise<ReadonlyArray<WarrantListItem>> {
  const ttlMs = cacheConfig.ttlMs;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    return requestWarrantList({
      ctx,
      monitorSymbol,
      warrantType,
      expiryFilters,
    });
  }

  const cacheKey = buildCacheKey(monitorSymbol, warrantType, expiryFilters);
  const nowMs = cacheConfig.nowMs();
  const cached = cacheConfig.cache.entries.get(cacheKey);
  if (cached && nowMs - cached.fetchedAt <= ttlMs) {
    return cached.warrants;
  }

  const inFlight = cacheConfig.cache.inFlight.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const request = requestWarrantList({
    ctx,
    monitorSymbol,
    warrantType,
    expiryFilters,
  });

  cacheConfig.cache.inFlight.set(cacheKey, request);

  try {
    const warrants = await request;
    cacheConfig.cache.entries.set(cacheKey, {
      fetchedAt: cacheConfig.nowMs(),
      warrants,
    });
    return warrants;
  } finally {
    cacheConfig.cache.inFlight.delete(cacheKey);
  }
}

/**
 * 获取并筛选最佳牛熊证标的。
 */
export async function findBestWarrant({
  ctx,
  monitorSymbol,
  isBull,
  tradingMinutes,
  minDistancePct,
  minTurnoverPerMinute,
  expiryMinMonths,
  logger,
  cacheConfig,
}: FindBestWarrantInput): Promise<WarrantCandidate | null> {
  try {
    const warrantType = isBull ? WarrantType.Bull : WarrantType.Bear;
    const expiryFilters = buildExpiryDateFilters(expiryMinMonths);
    const warrants = cacheConfig
      ? await fetchWarrantsWithCache({
        ctx,
        monitorSymbol,
        warrantType,
        expiryFilters,
        cacheConfig,
      })
      : await requestWarrantList({
        ctx,
        monitorSymbol,
        warrantType,
        expiryFilters,
      });

    const best = selectBestWarrant({
      warrants,
      tradingMinutes,
      isBull,
      minDistancePct,
      minTurnoverPerMinute,
    });

    if (!best) {
      logger.warn(
        `[自动寻标] 未找到符合条件的${isBull ? '牛' : '熊'}证：${monitorSymbol}`,
      );
    }

    return best;
  } catch (error) {
    logger.warn(
      `[自动寻标] warrantList 获取失败：${monitorSymbol}(${isBull ? '牛' : '熊'})`,
      formatError(error),
    );
    return null;
  }
}

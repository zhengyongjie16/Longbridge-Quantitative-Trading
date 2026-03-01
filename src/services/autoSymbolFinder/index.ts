/**
 * 自动寻标模块入口
 *
 * 功能：根据监控标的与方向从 LongPort 牛熊证列表筛选最佳标的（距回收价、分均成交额等）。
 * 职责：调用 warrantList API、到期日筛选、带缓存的列表获取、选优并返回 WarrantCandidate。
 * 执行流程：findBestWarrant 入参校验 → 可选缓存获取列表 → selectBestWarrant 筛选 → 返回最佳或 null。
 */
import {
  FilterWarrantInOutBoundsType,
  SortOrderType,
  WarrantSortBy,
  WarrantStatus,
  WarrantType,
  type FilterWarrantExpiryDate,
} from 'longport';
import { buildExpiryDateFilters, selectBestWarrant } from './utils.js';
import { formatError } from '../../utils/error/index.js';
import type {
  FindBestWarrantInput,
  WarrantCandidate,
  WarrantListItem,
  WarrantListFetchParams,
  WarrantListRequestParams,
} from './types.js';

/**
 * 构建牛熊证列表缓存键，用于 TTL 与请求去重。
 * @param monitorSymbol - 监控标的代码
 * @param warrantType - 牛熊证类型
 * @param expiryFilters - 到期日筛选条件数组
 * @returns 缓存键字符串
 */
function buildCacheKey(
  monitorSymbol: string,
  warrantType: WarrantType,
  expiryFilters: ReadonlyArray<FilterWarrantExpiryDate>,
): string {
  return `${monitorSymbol}:${String(warrantType)}:${expiryFilters.join(',')}`;
}

/**
 * 调用 LongPort warrantList API 请求牛熊证列表（按成交额降序）。
 * @param params - 请求参数（ctx、monitorSymbol、warrantType、expiryFilters）
 * @returns 牛熊证列表
 */
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

/**
 * 带缓存的牛熊证列表获取：命中 TTL 内缓存直接返回，否则请求 API 并写入缓存，并发请求去重。
 * @param params - 含 ctx、monitorSymbol、warrantType、expiryFilters、cacheConfig
 * @returns 牛熊证列表
 */
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
  const cached = cacheConfig.cache.getEntry(cacheKey);
  if (cached && nowMs - cached.fetchedAt <= ttlMs) {
    return cached.warrants;
  }
  const inFlight = cacheConfig.cache.getInFlight(cacheKey);
  if (inFlight) {
    return inFlight;
  }
  const request = requestWarrantList({
    ctx,
    monitorSymbol,
    warrantType,
    expiryFilters,
  });
  cacheConfig.cache.setInFlight(cacheKey, request);
  try {
    const warrants = await request;
    cacheConfig.cache.setEntry(cacheKey, {
      fetchedAt: cacheConfig.nowMs(),
      warrants,
    });
    return warrants;
  } finally {
    cacheConfig.cache.deleteInFlight(cacheKey);
  }
}

/**
 * 获取并筛选最佳牛熊证标的：按方向请求牛熊证列表，按距回收价与分均成交额选优。
 * 用于自动寻标与换标预寻标，无符合条件时返回 null 并打日志。
 * @param input - 寻标入参（ctx、monitorSymbol、isBull、tradingMinutes、阈值、cacheConfig 等）
 * @returns 最佳候选标的（symbol、name、callPrice、distancePct、turnover 等），无则 null
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
      const listLength = Array.isArray(warrants) ? warrants.length : 0;
      logger.warn(
        `[自动寻标] 未找到符合条件的${isBull ? '牛' : '熊'}证：${monitorSymbol}（列表条数=${listLength}，交易分钟数=${tradingMinutes}）`,
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

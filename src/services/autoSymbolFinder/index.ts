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
import { DEFAULT_PERCENT_DECIMALS, DEFAULT_PRICE_DECIMALS } from '../../constants/index.js';
import { buildExpiryDateFilters, selectBestWarrant } from './utils.js';
import { formatError } from '../../utils/error/index.js';
import { formatDecimal } from '../../utils/numeric/index.js';
import type {
  DirectionalAutoSearchPolicy,
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
 * 根据共享策略方向解析 warrantList 所需的牛熊证类型。
 * @param policy 方向化自动寻标策略
 * @returns LONG 返回 Bull，SHORT 返回 Bear
 */
function resolvePolicyWarrantType(policy: DirectionalAutoSearchPolicy): WarrantType {
  return policy.direction === 'LONG' ? WarrantType.Bull : WarrantType.Bear;
}

/**
 * 读取方向中文标签，用于日志区分牛证/熊证。
 * @param policy 方向化自动寻标策略
 * @returns LONG 返回「牛」，SHORT 返回「熊」
 */
function resolvePolicyDirectionLabel(policy: DirectionalAutoSearchPolicy): '牛' | '熊' {
  return policy.direction === 'LONG' ? '牛' : '熊';
}

/**
 * 记录自动寻标命中日志，显式区分主条件与降级条件。
 * @param params 日志参数
 * @returns 无返回值
 */
function logSelectedCandidate(params: {
  readonly logger: FindBestWarrantInput['logger'];
  readonly monitorSymbol: string;
  readonly tradingMinutes: number;
  readonly policy: DirectionalAutoSearchPolicy;
  readonly candidate: WarrantCandidate;
  readonly primaryCandidateCount: number;
  readonly degradedCandidateCount: number;
}): void {
  const directionLabel = resolvePolicyDirectionLabel(params.policy);
  const thresholdText = formatDecimal(params.policy.primaryThreshold, DEFAULT_PERCENT_DECIMALS);
  const degradedRangeText = `${formatDecimal(
    params.policy.degradedRange.min,
    DEFAULT_PERCENT_DECIMALS,
  )},${formatDecimal(params.policy.degradedRange.max, DEFAULT_PERCENT_DECIMALS)}`;
  const distanceText = formatDecimal(params.candidate.distancePct, DEFAULT_PERCENT_DECIMALS);
  const turnoverText = formatDecimal(params.candidate.turnoverPerMinute, 0);
  const distanceDeltaText = formatDecimal(
    params.candidate.distanceDeltaToThreshold,
    DEFAULT_PERCENT_DECIMALS,
  );
  const callPriceText = formatDecimal(params.candidate.callPrice, DEFAULT_PRICE_DECIMALS);
  if (params.candidate.selectionStage === 'PRIMARY') {
    params.logger.debug(
      `[自动寻标] 主条件命中${directionLabel}证：${params.monitorSymbol} -> ${params.candidate.symbol} ` +
        `(selectionStage=PRIMARY, distancePct=${distanceText}%, delta=${distanceDeltaText}%, ` +
        `threshold=${thresholdText}%, turnoverPerMinute=${turnoverText}, callPrice=${callPriceText}, ` +
        `primaryCandidates=${params.primaryCandidateCount}, tradingMinutes=${params.tradingMinutes})`,
    );
    return;
  }

  params.logger.debug(
    `[自动寻标] 主条件无候选，降级区间命中${directionLabel}证：${params.monitorSymbol} -> ${params.candidate.symbol} ` +
      `(selectionStage=DEGRADED, distancePct=${distanceText}%, delta=${distanceDeltaText}%, ` +
      `threshold=${thresholdText}%, degradedRange=${degradedRangeText}, turnoverPerMinute=${turnoverText}, ` +
      `callPrice=${callPriceText}, degradedCandidates=${params.degradedCandidateCount}, tradingMinutes=${params.tradingMinutes})`,
  );
}

/**
 * 记录自动寻标失败日志，显式说明主条件与降级条件均未命中。
 * @param params 日志参数
 * @returns 无返回值
 */
function logNoCandidateFound(params: {
  readonly logger: FindBestWarrantInput['logger'];
  readonly monitorSymbol: string;
  readonly tradingMinutes: number;
  readonly warrants: ReadonlyArray<WarrantListItem>;
  readonly policy: DirectionalAutoSearchPolicy;
  readonly primaryCandidateCount: number;
  readonly degradedCandidateCount: number;
}): void {
  const directionLabel = resolvePolicyDirectionLabel(params.policy);
  params.logger.warn(
    `[自动寻标] 主条件与降级条件均未命中${directionLabel}证：${params.monitorSymbol} ` +
      `(列表条数=${params.warrants.length}, 交易分钟数=${params.tradingMinutes}, ` +
      `primaryThreshold=${formatDecimal(params.policy.primaryThreshold, DEFAULT_PERCENT_DECIMALS)}%, ` +
      `degradedRange=${formatDecimal(params.policy.degradedRange.min, DEFAULT_PERCENT_DECIMALS)}%,` +
      `${formatDecimal(params.policy.degradedRange.max, DEFAULT_PERCENT_DECIMALS)}%, ` +
      `primaryCandidates=${params.primaryCandidateCount}, degradedCandidates=${params.degradedCandidateCount})`,
  );
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
 * @param input - 寻标入参（ctx、monitorSymbol、policy、tradingMinutes、cacheConfig 等）
 * @returns 最佳候选标的（symbol、name、callPrice、内部百分比值口径的 distancePct、turnover 等），无则 null
 */
export async function findBestWarrant({
  ctx,
  monitorSymbol,
  tradingMinutes,
  policy,
  expiryMinMonths,
  logger,
  cacheConfig,
}: FindBestWarrantInput): Promise<WarrantCandidate | null> {
  try {
    const warrantType = resolvePolicyWarrantType(policy);
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
    const selectionResult = selectBestWarrant({
      warrants,
      tradingMinutes,
      policy,
    });
    if (selectionResult.candidate === null) {
      logNoCandidateFound({
        logger,
        monitorSymbol,
        tradingMinutes,
        warrants,
        policy,
        primaryCandidateCount: selectionResult.primaryCandidateCount,
        degradedCandidateCount: selectionResult.degradedCandidateCount,
      });
      return null;
    }

    logSelectedCandidate({
      logger,
      monitorSymbol,
      tradingMinutes,
      policy,
      candidate: selectionResult.candidate,
      primaryCandidateCount: selectionResult.primaryCandidateCount,
      degradedCandidateCount: selectionResult.degradedCandidateCount,
    });
    return selectionResult.candidate;
  } catch (error) {
    logger.warn(
      `[自动寻标] warrantList 获取失败：${monitorSymbol}(${resolvePolicyDirectionLabel(policy)})`,
      formatError(error),
    );
    return null;
  }
}

import { WarrantStatus, type FilterWarrantExpiryDate } from 'longport';
import { EXPIRY_DATE_FILTERS } from '../../constants/index.js';
import {
  decimalAbs,
  decimalDiv,
  decimalEq,
  decimalGt,
  decimalLt,
  decimalMul,
  decimalSub,
  decimalToNumberValue,
  toDecimalValue,
  toDecimalStrict,
} from '../../utils/numeric/index.js';
import type {
  DirectionalAutoSearchPolicy,
  EvaluatedWarrantCandidate,
  RankedWarrantCandidate,
  SelectBestWarrantInput,
  WarrantCandidate,
  WarrantListCache,
  WarrantListCacheEntry,
  WarrantListItem,
  WarrantSelectionResult,
  WarrantSelectionStage,
} from './types.js';

const DISTANCE_RATIO_TO_PERCENT_MULTIPLIER = 100;

/**
 * 检查牛熊证状态是否为正常。
 * @param status 牛熊证状态枚举值
 * @returns true 表示状态为 Normal，可以交易
 */
function isNormalStatus(status: WarrantListItem['status']): boolean {
  return status === WarrantStatus.Normal;
}

/**
 * 判断共享策略方向是否为牛证方向。
 * @param policy 方向化自动寻标策略
 * @returns LONG 时返回 true，否则返回 false
 */
function isBullPolicy(policy: DirectionalAutoSearchPolicy): boolean {
  return policy.direction === 'LONG';
}

/**
 * 将 LongPort warrantList.toCallPrice 原始小数比值转换为内部百分比值。
 * 默认行为：仅接受可解析的 Decimal / number / string；转换后返回百分比值，
 * 例如 `0.0036` 转为 `0.36`，表示 `0.36%`。
 *
 * @param rawDistanceRatio warrantList.toCallPrice 原始值（小数比值）
 * @returns 内部百分比值；无法解析时返回 null
 */
export function normalizeWarrantDistancePercentFromApiRatio(
  rawDistanceRatio: WarrantListItem['toCallPrice'],
): ReturnType<typeof toDecimalStrict> {
  const distanceRatio = toDecimalStrict(rawDistanceRatio);
  if (distanceRatio === null) {
    return null;
  }

  return decimalMul(distanceRatio, DISTANCE_RATIO_TO_PERCENT_MULTIPLIER);
}

/**
 * 解析通过基础校验与流动性校验的候选快照。
 * 判定阶段保留 Decimal 精度，避免在进入双层候选带前降为 number。
 *
 * @param params 候选解析参数
 * @returns 合法候选快照，或 null
 */
function resolveEvaluatedWarrantCandidate(params: {
  readonly warrant: WarrantListItem;
  readonly tradingMinutes: number;
  readonly minTurnoverPerMinute: number;
}): EvaluatedWarrantCandidate | null {
  const { warrant, tradingMinutes, minTurnoverPerMinute } = params;
  if (!warrant.symbol || !isNormalStatus(warrant.status)) {
    return null;
  }

  const callPrice = toDecimalStrict(warrant.callPrice);
  if (callPrice === null || !decimalGt(callPrice, 0)) {
    return null;
  }

  const distancePct = normalizeWarrantDistancePercentFromApiRatio(warrant.toCallPrice);
  if (distancePct === null) {
    return null;
  }

  const turnover = toDecimalStrict(warrant.turnover);
  if (turnover === null || !decimalGt(turnover, 0)) {
    return null;
  }

  const hasTradingMinutes = tradingMinutes > 0;
  const shouldFilterTurnover = hasTradingMinutes || minTurnoverPerMinute > 0;
  if (shouldFilterTurnover) {
    if (!hasTradingMinutes) {
      return null;
    }

    const minTurnover = decimalMul(minTurnoverPerMinute, tradingMinutes);
    if (decimalLt(turnover, minTurnover)) {
      return null;
    }
  }

  const turnoverPerMinute = hasTradingMinutes
    ? decimalDiv(turnover, tradingMinutes)
    : toDecimalValue(0);
  if (decimalLt(turnoverPerMinute, minTurnoverPerMinute)) {
    return null;
  }

  return {
    symbol: warrant.symbol,
    name: warrant.name ?? null,
    callPrice,
    distancePct,
    turnover,
    turnoverPerMinute,
  };
}

/**
 * 根据共享策略判断候选命中的候选带。
 *
 * @param distancePct 候选距回收价百分比
 * @param policy 方向化自动寻标策略
 * @returns 命中阶段；两层都不命中时返回 null
 */
function resolveSelectionStage(
  distancePct: EvaluatedWarrantCandidate['distancePct'],
  policy: DirectionalAutoSearchPolicy,
): WarrantSelectionStage | null {
  const matchesPrimary = isBullPolicy(policy)
    ? decimalGt(distancePct, policy.primaryThreshold)
    : decimalLt(distancePct, policy.primaryThreshold);
  if (matchesPrimary) {
    return 'PRIMARY';
  }

  const matchesDegraded =
    decimalGt(distancePct, policy.degradedRange.min) &&
    decimalLt(distancePct, policy.degradedRange.max);
  return matchesDegraded ? 'DEGRADED' : null;
}

/**
 * 为已通过基础校验的候选附加命中阶段与距阈值差值。
 *
 * @param candidate 高精度候选快照
 * @param selectionStage 命中阶段
 * @param policy 方向化自动寻标策略
 * @returns 可参与排序的高精度候选
 */
function buildRankedCandidate(
  candidate: EvaluatedWarrantCandidate,
  selectionStage: WarrantSelectionStage,
  policy: DirectionalAutoSearchPolicy,
): RankedWarrantCandidate {
  return {
    ...candidate,
    selectionStage,
    distanceDeltaToThreshold: decimalAbs(
      decimalSub(candidate.distancePct, policy.primaryThreshold),
    ),
  };
}

/**
 * 判断候选是否应替换当前最佳候选。
 * 规则：距主阈值差值更小优先；若差值相同，分均成交额更高者优先；完全相同则保持原列表顺序。
 *
 * @param currentBest 当前最佳候选
 * @param nextCandidate 新候选
 * @returns 需要替换时返回 true
 */
function shouldReplaceBestCandidate(
  currentBest: RankedWarrantCandidate | null,
  nextCandidate: RankedWarrantCandidate,
): boolean {
  if (currentBest === null) {
    return true;
  }

  const deltaComparison = decimalLt(
    nextCandidate.distanceDeltaToThreshold,
    currentBest.distanceDeltaToThreshold,
  );
  if (deltaComparison) {
    return true;
  }

  const deltaEqual = decimalEq(
    nextCandidate.distanceDeltaToThreshold,
    currentBest.distanceDeltaToThreshold,
  );
  return deltaEqual && decimalGt(nextCandidate.turnoverPerMinute, currentBest.turnoverPerMinute);
}

/**
 * 将高精度候选转换为对外返回的 number 结构。
 *
 * @param candidate 高精度候选
 * @returns 对外返回的最佳候选
 */
function toWarrantCandidate(candidate: RankedWarrantCandidate): WarrantCandidate {
  return {
    symbol: candidate.symbol,
    name: candidate.name,
    callPrice: decimalToNumberValue(candidate.callPrice),
    distancePct: decimalToNumberValue(candidate.distancePct),
    turnover: decimalToNumberValue(candidate.turnover),
    turnoverPerMinute: decimalToNumberValue(candidate.turnoverPerMinute),
    selectionStage: candidate.selectionStage,
    distanceDeltaToThreshold: decimalToNumberValue(candidate.distanceDeltaToThreshold),
  };
}

/**
 * 创建牛熊证列表缓存实例，用于避免频繁调用 API，支持 TTL 缓存和请求去重。
 * @returns 实现了 WarrantListCache 接口的缓存对象
 */
export function createWarrantListCache(): WarrantListCache {
  const entries = new Map<string, WarrantListCacheEntry>();
  const inFlight = new Map<string, Promise<ReadonlyArray<WarrantListItem>>>();

  return {
    getEntry(key: string): WarrantListCacheEntry | undefined {
      return entries.get(key);
    },
    setEntry(key: string, entry: WarrantListCacheEntry): void {
      entries.set(key, entry);
    },
    getInFlight(key: string): Promise<ReadonlyArray<WarrantListItem>> | undefined {
      return inFlight.get(key);
    },
    setInFlight(key: string, request: Promise<ReadonlyArray<WarrantListItem>>): void {
      inFlight.set(key, request);
    },
    deleteInFlight(key: string): void {
      inFlight.delete(key);
    },
    clear(): void {
      entries.clear();
      inFlight.clear();
    },
  };
}

/**
 * 根据最小到期月数生成到期日筛选条件，避免选入临近到期标的。
 * @param expiryMinMonths 最小到期月数
 * @returns 对应的到期日筛选条件数组
 */
export function buildExpiryDateFilters(
  expiryMinMonths: number,
): ReadonlyArray<FilterWarrantExpiryDate> {
  if (!Number.isFinite(expiryMinMonths) || expiryMinMonths <= 3) {
    return EXPIRY_DATE_FILTERS;
  }

  if (expiryMinMonths <= 6) {
    return EXPIRY_DATE_FILTERS.slice(1);
  }

  return EXPIRY_DATE_FILTERS.slice(2);
}

/**
 * 从候选列表中选取最佳牛熊证标的。
 * - 主条件命中时，仅在主条件候选带内按"距主阈值最近"选优
 * - 只有主条件完全无候选时，才会进入降级候选带
 * - 判定阶段全程使用 Decimal，避免阈值邻域内的精度漂移
 * @param warrants 候选牛熊证列表
 * @param tradingMinutes 当日已交易分钟数，用于计算分均成交额
 * @param policy 方向化自动寻标策略
 * @returns 最佳候选与主层/降级层命中数量
 */
export function selectBestWarrant({
  warrants,
  tradingMinutes,
  policy,
}: SelectBestWarrantInput): WarrantSelectionResult {
  let bestPrimaryCandidate: RankedWarrantCandidate | null = null;
  let bestDegradedCandidate: RankedWarrantCandidate | null = null;
  let primaryCandidateCount = 0;
  let degradedCandidateCount = 0;
  for (const warrant of warrants) {
    const evaluatedCandidate = resolveEvaluatedWarrantCandidate({
      warrant,
      tradingMinutes,
      minTurnoverPerMinute: policy.minTurnoverPerMinute,
    });
    if (evaluatedCandidate === null) {
      continue;
    }

    const selectionStage = resolveSelectionStage(evaluatedCandidate.distancePct, policy);
    if (selectionStage === null) {
      continue;
    }

    const rankedCandidate = buildRankedCandidate(evaluatedCandidate, selectionStage, policy);
    if (selectionStage === 'PRIMARY') {
      primaryCandidateCount += 1;
      if (shouldReplaceBestCandidate(bestPrimaryCandidate, rankedCandidate)) {
        bestPrimaryCandidate = rankedCandidate;
      }

      continue;
    }

    degradedCandidateCount += 1;
    if (shouldReplaceBestCandidate(bestDegradedCandidate, rankedCandidate)) {
      bestDegradedCandidate = rankedCandidate;
    }
  }

  const selectedCandidate = bestPrimaryCandidate ?? bestDegradedCandidate;

  return {
    candidate: selectedCandidate === null ? null : toWarrantCandidate(selectedCandidate),
    primaryCandidateCount,
    degradedCandidateCount,
  };
}

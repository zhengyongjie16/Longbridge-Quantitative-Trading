/**
 * 自动换标模块：阈值解析与输入构造
 *
 * 职责：
 * - 解析多空阈值配置
 * - 构造自动寻标输入参数
 */
import type { AutoSearchConfig } from '../../types/config.js';
import type { FindBestWarrantInput } from '../autoSymbolFinder/types.js';
import type {
  BuildFindBestWarrantInput,
  BuildFindBestWarrantInputParams,
  ResolveAutoSearchThresholdInput,
  ResolveAutoSearchThresholdInputParams,
  ThresholdResolverDeps,
} from './types.js';

/**
 * 根据席位方向提取自动寻标阈值配置，避免错误混用多/空阈值。
 */
export function resolveAutoSearchThresholds(
  direction: 'LONG' | 'SHORT',
  config: AutoSearchConfig,
): {
  readonly minDistancePct: number | null;
  readonly minTurnoverPerMinute: number | null;
  readonly switchDistanceRange:
    | AutoSearchConfig['switchDistanceRangeBull']
    | AutoSearchConfig['switchDistanceRangeBear'];
} {
  const isBull = direction === 'LONG';
  return {
    minDistancePct: isBull ? config.autoSearchMinDistancePctBull : config.autoSearchMinDistancePctBear,
    minTurnoverPerMinute: isBull
      ? config.autoSearchMinTurnoverPerMinuteBull
      : config.autoSearchMinTurnoverPerMinuteBear,
    switchDistanceRange: isBull ? config.switchDistanceRangeBull : config.switchDistanceRangeBear,
  };
}

/**
 * 解析自动寻标阈值配置，校验多/空方向的必填阈值是否存在，缺失时记录错误并返回 null。
 */
function resolveAutoSearchThresholdInput(
  params: ResolveAutoSearchThresholdInputParams,
): Readonly<{
  minDistancePct: number;
  minTurnoverPerMinute: number;
}> | null {
  const { direction, autoSearchConfig, monitorSymbol, logPrefix, logger } = params;
  const { minDistancePct, minTurnoverPerMinute } = resolveAutoSearchThresholds(
    direction,
    autoSearchConfig,
  );
  if (minDistancePct == null || minTurnoverPerMinute == null) {
    logger.error(`${logPrefix}: ${monitorSymbol} ${direction}`);
    return null;
  }
  return { minDistancePct, minTurnoverPerMinute };
}

/**
 * 构造 FindBestWarrantInput，获取行情上下文并计算当前交易分钟数，组装寻标所需的完整输入参数。
 */
async function buildFindBestWarrantInput(
  params: BuildFindBestWarrantInputParams,
): Promise<FindBestWarrantInput> {
  const {
    direction,
    monitorSymbol,
    autoSearchConfig,
    currentTime,
    marketDataClient,
    warrantListCacheConfig,
    minDistancePct,
    minTurnoverPerMinute,
    getTradingMinutesSinceOpen,
    logger,
  } = params;
  const ctx = await marketDataClient.getQuoteContext();
  const tradingMinutes = getTradingMinutesSinceOpen(currentTime);
  const isBull = direction === 'LONG';
  return {
    ctx,
    monitorSymbol,
    isBull,
    tradingMinutes,
    minDistancePct,
    minTurnoverPerMinute,
    expiryMinMonths: autoSearchConfig.autoSearchExpiryMinMonths,
    logger,
    ...(warrantListCacheConfig ? { cacheConfig: warrantListCacheConfig } : {}),
  };
}

/**
 * 创建阈值解析器，将依赖注入绑定到内部函数，对外暴露统一的阈值解析与寻标输入构造接口。
 */
export function createThresholdResolver(
  deps: ThresholdResolverDeps,
): {
  resolveAutoSearchThresholdInput: ResolveAutoSearchThresholdInput;
  buildFindBestWarrantInput: BuildFindBestWarrantInput;
} {
  const {
    autoSearchConfig,
    monitorSymbol,
    marketDataClient,
    warrantListCacheConfig,
    logger,
    getTradingMinutesSinceOpen,
  } = deps;

  /** 绑定模块级依赖后转发至 resolveAutoSearchThresholdInput。 */
  function resolveAutoSearchThresholdInputWithDeps(
    params: Parameters<ResolveAutoSearchThresholdInput>[0],
  ): ReturnType<ResolveAutoSearchThresholdInput> {
    return resolveAutoSearchThresholdInput({
      ...params,
      autoSearchConfig,
      monitorSymbol,
      logger,
    });
  }

  /** 绑定模块级依赖后转发至 buildFindBestWarrantInput。 */
  async function buildFindBestWarrantInputWithDeps(
    params: Parameters<BuildFindBestWarrantInput>[0],
  ): Promise<FindBestWarrantInput> {
    return buildFindBestWarrantInput({
      ...params,
      autoSearchConfig,
      monitorSymbol,
      marketDataClient,
      getTradingMinutesSinceOpen,
      logger,
      ...(warrantListCacheConfig ? { warrantListCacheConfig } : {}),
    });
  }

  return {
    resolveAutoSearchThresholdInput: resolveAutoSearchThresholdInputWithDeps,
    buildFindBestWarrantInput: buildFindBestWarrantInputWithDeps,
  };
}

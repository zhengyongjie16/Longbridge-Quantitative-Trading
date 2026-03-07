/**
 * 自动换标模块：共享策略解析与 Finder 输入构造
 *
 * 功能：为自动换标模块提供策略解析与寻标输入构造能力。
 * 职责：解析方向化自动寻标共享策略，基于共享策略构造自动寻标 Finder 输入，并提供策略缓存优化。
 * 执行流程：createThresholdResolver 注入依赖 → 返回策略解析与输入构造函数 → 调用方使用绑定后的函数。
 */
import type { FindBestWarrantInput } from '../autoSymbolFinder/types.js';
import {
  buildFindBestWarrantInputFromPolicy,
  resolveDirectionalAutoSearchPolicy,
} from '../autoSymbolFinder/policyResolver.js';
import type {
  BuildFindBestWarrantInput,
  BuildFindBestWarrantInputParams,
  ResolveDirectionalAutoSearchPolicy,
  ThresholdResolverDeps,
} from './types.js';

/**
 * 构造 FindBestWarrantInput：获取行情上下文、计算当日交易分钟数，组装寻标所需的完整入参。
 * @param params - 含共享策略、currentTime、marketDataClient 等
 * @returns FindBestWarrantInput
 */
async function buildFindBestWarrantInput(
  params: BuildFindBestWarrantInputParams,
): Promise<FindBestWarrantInput> {
  const {
    monitorSymbol,
    currentTime,
    marketDataClient,
    warrantListCacheConfig,
    policy,
    expiryMinMonths,
    getTradingMinutesSinceOpen,
    logger,
  } = params;
  const ctx = await marketDataClient.getQuoteContext();
  return buildFindBestWarrantInputFromPolicy({
    ctx,
    monitorSymbol,
    currentTime,
    policy,
    expiryMinMonths,
    logger,
    getTradingMinutesSinceOpen,
    ...(warrantListCacheConfig ? { cacheConfig: warrantListCacheConfig } : {}),
  });
}

/**
 * 创建策略解析器，将依赖注入绑定到内部函数，对外暴露统一的共享策略解析与寻标输入构造接口。
 * @param deps - 依赖（autoSearchConfig、monitorSymbol、marketDataClient、logger、getTradingMinutesSinceOpen 等）
 * @returns 含 resolveDirectionalAutoSearchPolicy、buildFindBestWarrantInput 的对象
 */
export function createThresholdResolver(deps: ThresholdResolverDeps): {
  resolveDirectionalAutoSearchPolicy: ResolveDirectionalAutoSearchPolicy;
  buildFindBestWarrantInput: BuildFindBestWarrantInput;
} {
  const {
    autoSearchConfig,
    monitorSymbol,
    marketDataClient,
    warrantListCacheConfig,
    logger,
    getTradingMinutesSinceOpen,
    expiryMinMonths,
  } = deps;

  // 策略缓存：配置在运行时是静态的，避免重复构造
  const policyCache = new Map<'LONG' | 'SHORT', ReturnType<ResolveDirectionalAutoSearchPolicy>>();

  /** 绑定模块级依赖后转发至共享策略构造器。 */
  function resolveDirectionalAutoSearchPolicyWithDeps(
    params: Parameters<ResolveDirectionalAutoSearchPolicy>[0],
  ): ReturnType<ResolveDirectionalAutoSearchPolicy> {
    // 检查缓存
    const cached = policyCache.get(params.direction);
    if (cached !== undefined) {
      return cached;
    }

    // 构造并缓存
    const policy = resolveDirectionalAutoSearchPolicy({
      ...params,
      autoSearchConfig,
      monitorSymbol,
      logger,
    });
    policyCache.set(params.direction, policy);
    return policy;
  }

  /** 绑定模块级依赖后转发至 buildFindBestWarrantInput。 */
  async function buildFindBestWarrantInputWithDeps(
    params: Parameters<BuildFindBestWarrantInput>[0],
  ): Promise<FindBestWarrantInput> {
    return buildFindBestWarrantInput({
      ...params,
      monitorSymbol,
      marketDataClient,
      expiryMinMonths,
      getTradingMinutesSinceOpen,
      logger,
      ...(warrantListCacheConfig ? { warrantListCacheConfig } : {}),
    });
  }

  return {
    resolveDirectionalAutoSearchPolicy: resolveDirectionalAutoSearchPolicyWithDeps,
    buildFindBestWarrantInput: buildFindBestWarrantInputWithDeps,
  };
}

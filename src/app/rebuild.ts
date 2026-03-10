/**
 * app 重建接线模块
 *
 * 职责：
 * - 创建带按日缓存的交易日信息解析器
 * - 执行统一的开盘重建接线（load snapshot -> rebuild state）
 */
import type {
  CachedTradingDayInfo,
  RunTradingDayOpenRebuildParams,
  TradingDayInfoResolver,
  TradingDayInfoResolverDeps,
} from './types.js';

/**
 * 创建带按日缓存的交易日信息解析函数。
 * 默认行为：同日命中缓存直接返回；接口异常时回调 onResolveError 并返回非交易日结果。
 *
 * @param deps 依赖注入，包含交易日接口、日期键函数与错误回调
 * @returns 可直接用于 StartupGate 的 resolveTradingDayInfo 函数
 */
export function createTradingDayInfoResolver(
  deps: TradingDayInfoResolverDeps,
): TradingDayInfoResolver {
  const { marketDataClient, getHKDateKey: resolveDateKey, onResolveError } = deps;
  let cachedTradingDayInfo: CachedTradingDayInfo | null = null;

  return async function resolveTradingDayInfo(currentTime: Date) {
    const dateStr = resolveDateKey(currentTime) ?? currentTime.toISOString().slice(0, 10);
    if (cachedTradingDayInfo?.dateStr === dateStr) {
      return cachedTradingDayInfo.info;
    }

    try {
      const info = await marketDataClient.isTradingDay(currentTime);
      cachedTradingDayInfo = { dateStr, info };
      return info;
    } catch (err) {
      onResolveError(err);
      return {
        isTradingDay: false,
        isHalfDay: false,
      };
    }
  };
}

/**
 * 执行开盘重建：拉取运行时快照并重建当日状态。
 * 默认行为：固定使用 requireTradingDay=true、failOnOrderFetchError=true、resetRuntimeSubscriptions=true、hydrateCooldownFromTradeLog=false、forceOrderRefresh=true。
 *
 * @param params 开盘重建参数，包含 now、快照加载函数与重建函数
 * @returns 重建完成后返回 Promise<void>
 */
export async function executeTradingDayOpenRebuild(
  params: RunTradingDayOpenRebuildParams,
): Promise<void> {
  const { now, loadTradingDayRuntimeSnapshot, rebuildTradingDayState } = params;
  const openRebuildSnapshot = await loadTradingDayRuntimeSnapshot({
    now,
    requireTradingDay: true,
    failOnOrderFetchError: true,
    resetRuntimeSubscriptions: true,
    hydrateCooldownFromTradeLog: false,
    forceOrderRefresh: true,
  });

  await rebuildTradingDayState({
    allOrders: openRebuildSnapshot.allOrders,
    quotesMap: openRebuildSnapshot.quotesMap,
    now,
  });
}

import { logger } from '../../../utils/logger/index.js';
import type { CacheDomain, LifecycleContext } from '../types.js';
import type { MarketDataDomainDeps } from './types.js';

/**
 * 行情域午夜清理：重置订阅与缓存。
 * - 失败时上抛错误，由生命周期管理器进入失败重试节奏（不吞错）。
 * - allTradingSymbols 清理权威位置在 globalStateDomain，此处不再重复。
 */
export function createMarketDataDomain(deps: MarketDataDomainDeps): CacheDomain {
  const { marketDataClient } = deps;
  return {
    name: 'marketData',
    async midnightClear(_ctx: LifecycleContext): Promise<void> {
      await marketDataClient.resetRuntimeSubscriptionsAndCaches();
      logger.info('[Lifecycle][marketData] 午夜清理完成');
    },
    openRebuild(_ctx: LifecycleContext): void {
      // 行情订阅在统一开盘重建流水线中重建
    },
  };
}

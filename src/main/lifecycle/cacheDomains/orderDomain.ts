import { logger } from '../../../utils/logger/index.js';
import type { CacheDomain } from '../types.js';
import type { OrderDomainDeps } from './types.js';

export function createOrderDomain(deps: OrderDomainDeps): CacheDomain {
  const { trader } = deps;
  return {
    name: 'order',
    midnightClear(): void {
      trader._resetRuntimeState();
      logger.info('[Lifecycle][order] 午夜清理完成');
    },
    openRebuild(): void {
      // 订单重建在统一 rebuildTradingDayState 中执行
    },
  };
}

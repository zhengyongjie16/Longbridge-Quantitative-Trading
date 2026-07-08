/**
 * 席位刷新事实获取助手
 *
 * 功能：
 * - 获取席位刷新所需的最新订单、账户与持仓事实
 * - 统一刷新账户与持仓缓存
 */
import type { LastState } from '../../../../types/state.js';
import type { RawOrderFromAPI, Trader } from '../../../../types/services.js';
import type { QuoteSubscriptionRuntime } from '../../../quoteSubscriptionRuntime/types.js';
import type { RefreshHelpers } from '../types.js';

/**
 * 创建刷新助手，用于为每个席位刷新任务获取同一任务时段内的最新事实。
 *
 * @param deps 包含 trader、lastState
 * @returns RefreshHelpers，含 ensureAllOrders、refreshAccountCaches
 */
export function createRefreshHelpers({
  trader,
  lastState,
  quoteSubscriptionRuntime,
}: {
  readonly trader: Trader;
  readonly lastState: LastState;
  readonly quoteSubscriptionRuntime?: Pick<
    QuoteSubscriptionRuntime,
    'reconcilePositionHoldFromCurrentTruth'
  >;
}): RefreshHelpers {
  /**
   * 获取当前席位刷新使用的全量订单事实。
   * 队列消费期间仍可动态入队并发生独立交易，不能跨任务复用订单快照。
   *
   * @returns 当前时点的全量订单列表
   */
  async function ensureAllOrders(): Promise<ReadonlyArray<RawOrderFromAPI>> {
    return trader.orderRecorder.fetchAllOrdersFromAPI(true);
  }

  /**
   * 获取当前席位刷新使用的账户与持仓事实并更新运行态缓存。
   * 队列消费期间仍可动态入队并发生独立交易，不能跨任务复用账户或持仓快照。
   *
   * @returns Promise，无返回值；副作用为更新 lastState.cachedAccount、cachedPositions、positionCache
   */
  async function refreshAccountCaches(): Promise<void> {
    const accountSnapshot = await trader.getAccountSnapshot();
    const positionsSnapshot = await trader.getStockPositions();
    lastState.cachedAccount = accountSnapshot;
    lastState.cachedPositions = [...positionsSnapshot];
    lastState.positionCache.update(positionsSnapshot);
    await quoteSubscriptionRuntime?.reconcilePositionHoldFromCurrentTruth();
  }

  return {
    ensureAllOrders,
    refreshAccountCaches,
  };
}

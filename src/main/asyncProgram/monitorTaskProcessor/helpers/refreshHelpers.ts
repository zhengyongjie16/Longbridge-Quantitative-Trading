/**
 * 刷新助手与缓存生命周期
 *
 * 功能：
 * - 缓存订单与账户数据，避免批次内重复请求
 * - 统一刷新账户与持仓缓存
 * - 缓存生命周期仅限单次队列批处理
 */
import type { LastState } from '../../../../types/state.js';
import type { Position } from '../../../../types/account.js';
import type { RawOrderFromAPI, Trader } from '../../../../types/services.js';
import type { MonitorTaskContext, RefreshHelpers } from '../types.js';

/**
 * 创建刷新助手，用于监控任务批处理内缓存订单与账户数据，避免重复请求。
 *
 * @param deps 包含 trader、lastState
 * @returns RefreshHelpers，含 ensureAllOrders、refreshAccountCaches
 */
export function createRefreshHelpers({
  trader,
  lastState,
}: {
  readonly trader: Trader;
  readonly lastState: LastState;
}): RefreshHelpers {
  const cachedAllOrdersByMonitor = new Map<string, ReadonlyArray<RawOrderFromAPI>>();
  let cachedAccountSnapshot: typeof lastState.cachedAccount | null | undefined;
  let cachedPositionsSnapshot: ReadonlyArray<Position> | null | undefined;

  /**
   * 获取指定监控标的的全量订单，批次内命中缓存则直接返回，避免重复请求 API
   *
   * @param monitorSymbol 监控标的代码
   * @param orderRecorder 订单记录器，用于拉取全量订单
   * @returns 该监控标的对应的全量订单列表
   */
  async function ensureAllOrders(
    monitorSymbol: string,
    orderRecorder: MonitorTaskContext['orderRecorder'],
  ): Promise<ReadonlyArray<RawOrderFromAPI>> {
    const cached = cachedAllOrdersByMonitor.get(monitorSymbol);
    if (cached) {
      return cached;
    }
    const allOrders = await orderRecorder.fetchAllOrdersFromAPI(true);
    cachedAllOrdersByMonitor.set(monitorSymbol, allOrders);
    return allOrders;
  }

  /**
   * 刷新账户快照与持仓缓存，批次内已刷新则跳过，避免重复请求
   *
   * @returns Promise，无返回值；副作用为更新 lastState.cachedAccount、cachedPositions、positionCache
   */
  async function refreshAccountCaches(): Promise<void> {
    if (cachedAccountSnapshot === undefined) {
      cachedAccountSnapshot = await trader.getAccountSnapshot();
      if (cachedAccountSnapshot) {
        lastState.cachedAccount = cachedAccountSnapshot;
      }
    }
    if (cachedPositionsSnapshot === undefined) {
      cachedPositionsSnapshot = await trader.getStockPositions();
      if (cachedPositionsSnapshot) {
        lastState.cachedPositions = [...cachedPositionsSnapshot];
        lastState.positionCache.update(cachedPositionsSnapshot);
      }
    }
  }

  return {
    ensureAllOrders,
    refreshAccountCaches,
  };
}

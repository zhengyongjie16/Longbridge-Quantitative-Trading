/**
 * 模块名称：刷新助手与缓存生命周期
 *
 * 功能：
 * - 缓存订单与账户数据，避免批次内重复请求
 * - 统一刷新账户与持仓缓存
 *
 * 说明：
 * - 缓存生命周期仅限单次队列批处理
 */
import type { LastState, Position, RawOrderFromAPI, Trader } from '../../../../types/index.js';
import type { MonitorTaskContext, RefreshHelpers } from '../types.js';

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

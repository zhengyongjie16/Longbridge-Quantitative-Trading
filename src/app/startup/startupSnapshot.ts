/**
 * app 启动快照分支协同模块
 *
 * 职责：
 * - 执行 startup snapshot load
 * - 在外部 API 失败时切换到 pendingOpenRebuild 恢复分支
 * - 成功时返回权威快照，API retry pending 时不携带空事实
 */
import { isExternalApiRequestError } from '../../utils/apiFailure/index.js';
import type { LoadStartupSnapshotParams, StartupSnapshotResult } from '../types.js';

/**
 * 执行启动快照加载，并在失败时切换为开盘重建恢复模式。
 *
 * @param params 启动快照加载所需依赖与当前时间
 * @returns startup snapshot 成功或失败后的统一结果
 */
export async function loadStartupSnapshot(
  params: LoadStartupSnapshotParams,
): Promise<StartupSnapshotResult> {
  const {
    now,
    lastState,
    loadTradingDayRuntimeSnapshot,
    applyStartupSnapshotFailureState,
    logger,
    formatError,
  } = params;

  try {
    const startupSnapshot = await loadTradingDayRuntimeSnapshot({
      now,
      requireTradingDay: false,
      resetRuntimeSubscriptions: false,
      hydrateCooldownFromTradeLog: true,
      forceOrderRefresh: false,
    });

    return {
      kind: 'READY',
      allOrders: startupSnapshot.allOrders,
      quotesMap: startupSnapshot.quotesMap,
      now,
    };
  } catch (err) {
    if (!isExternalApiRequestError(err)) {
      throw err;
    }

    applyStartupSnapshotFailureState(lastState, now);
    logger.error('启动快照 API 请求失败：已阻断交易并切换为开盘重建重试模式', formatError(err));
    return {
      kind: 'API_RETRY_PENDING',
      now,
    };
  }
}

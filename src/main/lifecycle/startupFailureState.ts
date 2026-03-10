/**
 * 启动失败生命周期状态协同模块
 *
 * 职责：
 * - 在启动快照失败时切换生命周期状态
 * - 固化 pendingOpenRebuild 为当前恢复触发契约
 * - 保留 targetTradingDayKey 作为目标交易日观测字段
 */
import type { LastState } from '../../types/state.js';
import { getHKDateKey } from '../../utils/time/index.js';

/**
 * 将全局状态切换为"启动快照失败，等待开盘重建重试"。
 * 默认行为：阻断交易并标记 pendingOpenRebuild，目标交易日使用当前时间的港股交易日 key。
 *
 * @param lastState 全局可变状态
 * @param now 当前时间（用于计算目标交易日）
 * @returns 无返回值，直接原地更新 lastState
 */
export function applyStartupSnapshotFailureState(lastState: LastState, now: Date): void {
  lastState.pendingOpenRebuild = true;
  lastState.lifecycleState = 'OPEN_REBUILD_FAILED';
  lastState.isTradingEnabled = false;
  lastState.targetTradingDayKey = getHKDateKey(now);
}

import type { RunMode, GateMode } from '../../types/seat.js';
import type { LastState } from '../../types/state.js';
import { getHKDateKey } from '../../utils/tradingTime/index.js';
/**
 * 从环境变量解析运行模式。未设置或非 'dev' 时默认为 'prod'。
 *
 * @param env 环境变量对象（如 process.env）
 * @returns 'dev' 或 'prod'，默认 'prod'
 */
export function resolveRunMode(env: NodeJS.ProcessEnv): RunMode {
  const raw = env['RUN_MODE'];
  const normalized = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return normalized === 'dev' ? 'dev' : 'prod';
}
/**
 * 根据运行模式解析门禁策略。dev 时启动与运行时均跳过门禁（skip），否则均为严格模式（strict）。
 *
 * @param runMode 运行模式（'dev' | 'prod'）
 * @returns 启动门禁与运行时门禁的配置（startupGate、runtimeGate）
 */
export function resolveGatePolicies(runMode: RunMode): {
  readonly startupGate: GateMode;
  readonly runtimeGate: GateMode;
} {
  if (runMode === 'dev') {
    return { startupGate: 'skip', runtimeGate: 'skip' };
  }
  return { startupGate: 'strict', runtimeGate: 'strict' };
}
/**
 * 将全局状态切换为“启动快照失败，等待开盘重建重试”。
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

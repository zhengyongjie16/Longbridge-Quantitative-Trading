/**
 * 席位快照校验助手
 *
 * 功能：
 * - 校验席位快照一致性与版本，避免旧任务在换标后执行
 */
import { isSeatVersionMatch } from '../../../../utils/seat/guards.js';

import type { MonitorTaskContext, SeatSnapshot } from '../types.js';

/**
 * 校验席位快照是否与当前席位状态一致
 * 同时比对版本号、标的与激活基线，防止旧任务在换标后被错误执行
 *
 * @param monitorSymbol 监控标的代码
 * @param direction 方向（LONG 或 SHORT）
 * @param snapshot 任务携带的席位快照（版本号 + 标的 + 激活基线）
 * @param context 监控上下文，为 null 时返回 false
 * @returns 版本、标的与激活基线均一致时返回 true
 */
export function isSeatSnapshotValid(
  monitorSymbol: string,
  direction: 'LONG' | 'SHORT',
  snapshot: SeatSnapshot,
  context: MonitorTaskContext | null,
): boolean {
  if (!context) {
    return false;
  }

  const seatState = context.symbolRegistry.getSeatState(monitorSymbol, direction);
  const currentVersion = context.symbolRegistry.getSeatVersion(monitorSymbol, direction);
  if (!isSeatVersionMatch(snapshot.seatVersion, currentVersion)) {
    return false;
  }

  if (seatState.symbol !== snapshot.symbol) {
    return false;
  }

  return seatState.lastSeatActivatedAt === snapshot.lastSeatActivatedAt;
}

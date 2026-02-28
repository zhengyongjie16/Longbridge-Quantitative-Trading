/**
 * 席位快照校验助手
 *
 * 功能：
 * - 校验席位快照一致性与版本
 * - 计算席位就绪状态与可用标的
 * - 刷新后再校验快照，避免旧席位任务执行
 */
import { isSeatVersionMatch } from '../../../../services/autoSymbolManager/utils.js';

import type { SeatState } from '../../../../types/seat.js';
import type { RefreshGate } from '../../../../utils/types.js';
import type { MonitorTaskContext, SeatSnapshot } from '../types.js';

/**
 * 判断席位是否持有有效标的（symbol 为非空字符串）
 *
 * @param seatState 席位状态
 * @returns 标的为非空字符串时返回 true
 */
export const isSeatSymbolActive = (seatState: SeatState): boolean => {
  return typeof seatState.symbol === 'string' && seatState.symbol.length > 0;
};

/**
 * 校验席位快照是否与当前席位状态一致
 * 同时比对版本号与标的，防止旧任务在换标后被错误执行
 *
 * @param monitorSymbol 监控标的代码
 * @param direction 方向（LONG 或 SHORT）
 * @param snapshot 任务携带的席位快照（版本号 + 标的）
 * @param context 监控上下文，为 null 时返回 false
 * @returns 版本与标的均一致时返回 true
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
  return seatState.symbol === snapshot.symbol;
}

/**
 * 等待行情刷新后再次校验双向席位快照
 * 两次校验均失败时返回 null，避免旧席位任务在换标后执行
 *
 * @param monitorSymbol 监控标的代码
 * @param context 监控上下文
 * @param longSnapshot 多头席位快照
 * @param shortSnapshot 空头席位快照
 * @param refreshGate 刷新门禁，用于 waitForFresh
 * @returns 刷新后 longValid/shortValid 结果，两次校验均无有效席位时返回 null
 */
export async function validateSeatSnapshotsAfterRefresh({
  monitorSymbol,
  context,
  longSnapshot,
  shortSnapshot,
  refreshGate,
}: {
  readonly monitorSymbol: string;
  readonly context: MonitorTaskContext;
  readonly longSnapshot: SeatSnapshot;
  readonly shortSnapshot: SeatSnapshot;
  readonly refreshGate: RefreshGate;
}): Promise<Readonly<{ longValid: boolean; shortValid: boolean }> | null> {
  const hasLongSnapshot = isSeatSnapshotValid(monitorSymbol, 'LONG', longSnapshot, context);
  const hasShortSnapshot = isSeatSnapshotValid(monitorSymbol, 'SHORT', shortSnapshot, context);
  if (!hasLongSnapshot && !hasShortSnapshot) {
    return null;
  }

  await refreshGate.waitForFresh();

  const longValid = isSeatSnapshotValid(monitorSymbol, 'LONG', longSnapshot, context);
  const shortValid = isSeatSnapshotValid(monitorSymbol, 'SHORT', shortSnapshot, context);
  if (!longValid && !shortValid) {
    return null;
  }

  return { longValid, shortValid };
}

/**
 * 根据快照校验结果与席位可用性判断，计算双向席位的就绪状态与可用标的
 *
 * @param monitorSymbol 监控标的代码
 * @param context 监控上下文
 * @param snapshotValidity 刷新后的 longValid/shortValid 结果
 * @param isSeatUsable 判断席位是否可用的函数（如 isSeatReady）
 * @returns 双向席位状态、就绪标志及 longSymbol/shortSymbol
 */
export function resolveSeatSnapshotReadiness({
  monitorSymbol,
  context,
  snapshotValidity,
  isSeatUsable,
}: {
  readonly monitorSymbol: string;
  readonly context: MonitorTaskContext;
  readonly snapshotValidity: Readonly<{ longValid: boolean; shortValid: boolean }>;
  readonly isSeatUsable: (seatState: SeatState) => boolean;
}): Readonly<{
  longSeat: SeatState;
  shortSeat: SeatState;
  isLongReady: boolean;
  isShortReady: boolean;
  longSymbol: string;
  shortSymbol: string;
}> {
  const longSeat = context.symbolRegistry.getSeatState(monitorSymbol, 'LONG');
  const shortSeat = context.symbolRegistry.getSeatState(monitorSymbol, 'SHORT');

  const isLongReady = snapshotValidity.longValid && isSeatUsable(longSeat);
  const isShortReady = snapshotValidity.shortValid && isSeatUsable(shortSeat);

  const longSymbol = isLongReady && typeof longSeat.symbol === 'string' ? longSeat.symbol : '';
  const shortSymbol = isShortReady && typeof shortSeat.symbol === 'string' ? shortSeat.symbol : '';

  return {
    longSeat,
    shortSeat,
    isLongReady,
    isShortReady,
    longSymbol,
    shortSymbol,
  } as const;
}

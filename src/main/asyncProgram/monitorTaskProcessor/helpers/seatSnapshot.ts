/**
 * 模块名称：席位快照校验助手
 *
 * 功能：
 * - 校验席位快照一致性与版本
 * - 计算席位就绪状态与可用标的
 *
 * 说明：
 * - 刷新后再校验快照，避免旧席位任务执行
 */
import { isSeatVersionMatch } from '../../../../services/autoSymbolManager/utils.js';

import type { SeatState } from '../../../../types/index.js';
import type { RefreshGate } from '../../../../utils/refreshGate/types.js';
import type { MonitorTaskContext, SeatSnapshot } from '../types.js';

export const isSeatSymbolActive = (seatState: SeatState): boolean => {
  return typeof seatState.symbol === 'string' && seatState.symbol.length > 0;
};

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

  const longSymbol =
    isLongReady && typeof longSeat.symbol === 'string' ? longSeat.symbol : '';
  const shortSymbol =
    isShortReady && typeof shortSeat.symbol === 'string' ? shortSeat.symbol : '';

  return {
    longSeat,
    shortSeat,
    isLongReady,
    isShortReady,
    longSymbol,
    shortSymbol,
  } as const;
}

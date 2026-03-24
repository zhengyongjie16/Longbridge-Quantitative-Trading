import type { SeatState } from '../../types/seat.js';

/**
 * 判断席位是否处于可交易激活态（ACTIVE 且绑定有效 symbol）。
 *
 * @param seatState 席位状态，可为 null 或 undefined
 * @returns 席位已激活时返回 true，并收窄为包含非空 symbol 的 SeatState
 */
export function isSeatActive(
  seatState: SeatState | null | undefined,
): seatState is SeatState & { symbol: string } {
  if (!seatState) {
    return false;
  }

  if (seatState.status !== 'ACTIVE') {
    return false;
  }

  return typeof seatState.symbol === 'string' && seatState.symbol.length > 0;
}

/**
 * 判断席位是否已绑定有效 symbol（不要求 ACTIVE）。
 *
 * @param seatState 席位状态，可为 null 或 undefined
 * @returns 只要 symbol 为非空字符串即返回 true
 */
export function hasSeatSymbol(
  seatState: SeatState | null | undefined,
): seatState is SeatState & { symbol: string } {
  return (
    seatState !== null &&
    seatState !== undefined &&
    typeof seatState.symbol === 'string' &&
    seatState.symbol.length > 0
  );
}

/**
 * 判断信号席位版本与当前席位版本是否一致。
 *
 * @param signalVersion 信号携带的 seatVersion
 * @param currentVersion 当前席位版本
 * @returns 版本一致时返回 true
 */
export function isSeatVersionMatch(
  signalVersion: number | null | undefined,
  currentVersion: number,
): boolean {
  return Number.isFinite(signalVersion) && signalVersion === currentVersion;
}

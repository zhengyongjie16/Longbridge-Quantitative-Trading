/**
 * 监控任务处理器公共工具
 *
 * 功能：
 * - 提供「获取上下文 + 校验席位快照 + 解析席位就绪」的公共流程，供 liquidationDistance、unrealizedLoss 等 handler 复用
 */
import { isSeatReady } from '../../../services/autoSymbolManager/utils.js';
import type { SeatState } from '../../../types/seat.js';
import type { RefreshGate } from '../../../utils/types.js';
import type { MonitorTaskContext, SeatSnapshot } from './types.js';
import {
  resolveSeatSnapshotReadiness,
  validateSeatSnapshotsAfterRefresh,
} from './helpers/seatSnapshot.js';

/**
 * 监控上下文与席位就绪结果。
 * 类型用途：evaluateMonitorContextAndSeatReadiness 的返回值，供 liquidationDistance、unrealizedLoss 等 handler 使用。
 * 数据来源：由 evaluateMonitorContextAndSeatReadiness 在校验与解析后构造。
 * 使用范围：仅 monitorTaskProcessor 各 handler 内部使用。
 */
export type MonitorContextAndSeatReadiness = Readonly<{
  context: MonitorTaskContext;
  seatReadiness: Readonly<{
    longSeat: SeatState;
    shortSeat: SeatState;
    isLongReady: boolean;
    isShortReady: boolean;
    longSymbol: string;
    shortSymbol: string;
  }>;
}>;

/**
 * 获取监控上下文并完成席位快照校验与就绪解析；任一环节失败则返回 null（调用方应返回 'skipped'）。
 *
 * @param params.getContextOrSkip 按监控标的获取上下文，无则返回 null
 * @param params.refreshGate 刷新门禁，用于等待缓存刷新后再校验快照
 * @param params.monitorSymbol 监控标的
 * @param params.longSnapshot 多头席位快照（版本与标的）
 * @param params.shortSnapshot 空头席位快照（版本与标的）
 * @returns 成功时返回 context 与 seatReadiness，否则返回 null
 */
export async function evaluateMonitorContextAndSeatReadiness(params: {
  readonly getContextOrSkip: (monitorSymbol: string) => MonitorTaskContext | null;
  readonly refreshGate: RefreshGate;
  readonly monitorSymbol: string;
  readonly longSnapshot: SeatSnapshot;
  readonly shortSnapshot: SeatSnapshot;
}): Promise<MonitorContextAndSeatReadiness | null> {
  const {
    getContextOrSkip,
    refreshGate,
    monitorSymbol,
    longSnapshot,
    shortSnapshot,
  } = params;
  const context = getContextOrSkip(monitorSymbol);
  if (!context) {
    return null;
  }
  const snapshotValidity = await validateSeatSnapshotsAfterRefresh({
    monitorSymbol,
    context,
    longSnapshot: { seatVersion: longSnapshot.seatVersion, symbol: longSnapshot.symbol },
    shortSnapshot: { seatVersion: shortSnapshot.seatVersion, symbol: shortSnapshot.symbol },
    refreshGate,
  });
  if (!snapshotValidity) {
    return null;
  }
  const seatReadiness = resolveSeatSnapshotReadiness({
    monitorSymbol,
    context,
    snapshotValidity,
    isSeatUsable: isSeatReady,
  });
  return { context, seatReadiness };
}

/**
 * 监控任务处理器公共工具
 *
 * 功能：
 * - 提供「获取上下文 + 校验席位快照 + 解析席位就绪」的公共流程，供 liquidationDistance 与自动换标 handler 复用
 */
import { isSeatActive } from '../../../utils/seat/guards.js';
import { logger } from '../../../utils/logger/index.js';
import type { PostTradeConsistencyFreshnessPort } from '../../../types/services.js';
import type { MonitorContextAndSeatReadiness, MonitorTaskContext, SeatSnapshot } from './types.js';
import {
  resolveSeatSnapshotReadiness,
  validateSeatSnapshotsAfterRefresh,
} from './helpers/seatSnapshot.js';

/**
 * 获取监控上下文并完成席位快照校验与就绪解析；任一环节失败则返回 null（调用方应返回 'skipped'）。
 *
 * @param params.getContextOrSkip 按监控标的获取上下文，无则返回 null
 * @param params.postTradeConsistencyRuntime 成交后一致性 freshness 等待端口，用于等待缓存刷新后再校验快照
 * @param params.monitorSymbol 监控标的
 * @param params.longSnapshot 多头席位快照（版本与标的）
 * @param params.shortSnapshot 空头席位快照（版本与标的）
 * @returns 成功时返回 context 与 seatReadiness，否则返回 null
 */
export async function evaluateMonitorContextAndSeatReadiness(params: {
  readonly getContextOrSkip: (monitorSymbol: string) => MonitorTaskContext | null;
  readonly postTradeConsistencyRuntime: PostTradeConsistencyFreshnessPort;
  readonly monitorSymbol: string;
  readonly longSnapshot: SeatSnapshot;
  readonly shortSnapshot: SeatSnapshot;
}): Promise<MonitorContextAndSeatReadiness | null> {
  const {
    getContextOrSkip,
    postTradeConsistencyRuntime,
    monitorSymbol,
    longSnapshot,
    shortSnapshot,
  } = params;
  const context = getContextOrSkip(monitorSymbol);
  if (!context) {
    logger.debug(`[MonitorTaskProcessor] 上下文缺失，跳过 monitor=${monitorSymbol}`);
    return null;
  }

  const snapshotValidity = await validateSeatSnapshotsAfterRefresh({
    monitorSymbol,
    context,
    longSnapshot: { seatVersion: longSnapshot.seatVersion, symbol: longSnapshot.symbol },
    shortSnapshot: { seatVersion: shortSnapshot.seatVersion, symbol: shortSnapshot.symbol },
    postTradeConsistencyRuntime,
  });
  if (!snapshotValidity) {
    logger.debug(`[MonitorTaskProcessor] 席位快照失效，跳过 monitor=${monitorSymbol}`);
    return null;
  }

  const seatReadiness = resolveSeatSnapshotReadiness({
    monitorSymbol,
    context,
    snapshotValidity,
    isSeatUsable: isSeatActive,
  });
  return { context, seatReadiness };
}

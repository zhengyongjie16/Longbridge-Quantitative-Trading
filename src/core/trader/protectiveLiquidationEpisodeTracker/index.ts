/**
 * 保护性清仓事件跟踪器
 *
 * 功能/职责：按 monitorSymbol + direction 维护保护性清仓进行中事件与已完成边界，保证单次事件只完成一次。
 * 执行流程：settlementFlow 在保护性成交时记录进度；postTradeRefresher 在持仓刷新后判定完成并推进边界。
 */
import { buildCooldownKey } from '../../../services/liquidationCooldown/utils.js';
import type {
  InProgressProtectiveEpisode,
  ProtectiveLiquidationCompletedEvent,
  ProtectiveLiquidationEpisodeTracker,
} from './types.js';

/**
 * 创建保护性清仓事件跟踪器。
 *
 * @returns ProtectiveLiquidationEpisodeTracker
 */
export function createProtectiveLiquidationEpisodeTracker(): ProtectiveLiquidationEpisodeTracker {
  const latestProtectionBoundaryByDirection = new Map<string, number>();
  const inProgressByDirection = new Map<string, InProgressProtectiveEpisode>();

  function recordProtectiveFillProgress(params: {
    monitorSymbol: string;
    direction: 'LONG' | 'SHORT';
    executedTimeMs: number;
  }): void {
    const { monitorSymbol, direction, executedTimeMs } = params;
    if (!Number.isFinite(executedTimeMs) || executedTimeMs <= 0) {
      return;
    }

    const key = buildCooldownKey(monitorSymbol, direction);
    const existingBoundary = latestProtectionBoundaryByDirection.get(key);
    if (existingBoundary !== undefined && executedTimeMs <= existingBoundary) {
      return;
    }

    const existing = inProgressByDirection.get(key);
    if (!existing) {
      inProgressByDirection.set(key, {
        monitorSymbol,
        direction,
        latestExecutedTimeMs: executedTimeMs,
      });
      return;
    }

    if (executedTimeMs > existing.latestExecutedTimeMs) {
      inProgressByDirection.set(key, {
        monitorSymbol,
        direction,
        latestExecutedTimeMs: executedTimeMs,
      });
    }
  }

  function completeIfEligible(params: {
    monitorSymbol: string;
    direction: 'LONG' | 'SHORT';
    isDirectionFlat: boolean;
    hasPendingProtectiveOrders: boolean;
  }): ProtectiveLiquidationCompletedEvent | null {
    const { monitorSymbol, direction, isDirectionFlat, hasPendingProtectiveOrders } = params;
    if (!isDirectionFlat || hasPendingProtectiveOrders) {
      return null;
    }

    const key = buildCooldownKey(monitorSymbol, direction);
    const inProgress = inProgressByDirection.get(key);
    if (!inProgress) {
      return null;
    }

    inProgressByDirection.delete(key);
    const previousBoundary = latestProtectionBoundaryByDirection.get(key);
    if (previousBoundary !== undefined && inProgress.latestExecutedTimeMs <= previousBoundary) {
      return null;
    }

    latestProtectionBoundaryByDirection.set(key, inProgress.latestExecutedTimeMs);
    return {
      monitorSymbol,
      direction,
      boundaryExecutedTimeMs: inProgress.latestExecutedTimeMs,
    };
  }

  function restoreCompletedBoundary(params: {
    monitorSymbol: string;
    direction: 'LONG' | 'SHORT';
    boundaryExecutedTimeMs: number;
  }): void {
    const { monitorSymbol, direction, boundaryExecutedTimeMs } = params;
    if (!Number.isFinite(boundaryExecutedTimeMs) || boundaryExecutedTimeMs <= 0) {
      return;
    }

    const key = buildCooldownKey(monitorSymbol, direction);
    const existingBoundary = latestProtectionBoundaryByDirection.get(key);
    if (existingBoundary !== undefined && boundaryExecutedTimeMs <= existingBoundary) {
      return;
    }

    latestProtectionBoundaryByDirection.set(key, boundaryExecutedTimeMs);
    inProgressByDirection.delete(key);
  }

  function restoreInProgressEpisode(params: {
    monitorSymbol: string;
    direction: 'LONG' | 'SHORT';
    latestExecutedTimeMs: number;
  }): void {
    const { monitorSymbol, direction, latestExecutedTimeMs } = params;
    if (!Number.isFinite(latestExecutedTimeMs) || latestExecutedTimeMs <= 0) {
      return;
    }

    const key = buildCooldownKey(monitorSymbol, direction);
    const existingBoundary = latestProtectionBoundaryByDirection.get(key);
    if (existingBoundary !== undefined && latestExecutedTimeMs <= existingBoundary) {
      return;
    }

    const existing = inProgressByDirection.get(key);
    if (existing && latestExecutedTimeMs <= existing.latestExecutedTimeMs) {
      return;
    }

    inProgressByDirection.set(key, {
      monitorSymbol,
      direction,
      latestExecutedTimeMs,
    });
  }

  function getLatestProtectionBoundaryByDirection(): ReadonlyMap<string, number> {
    return new Map(latestProtectionBoundaryByDirection);
  }

  function getInProgressEpisodes(): ReadonlyArray<InProgressProtectiveEpisode> {
    return [...inProgressByDirection.values()];
  }

  function resetAll(): void {
    latestProtectionBoundaryByDirection.clear();
    inProgressByDirection.clear();
  }

  return {
    recordProtectiveFillProgress,
    completeIfEligible,
    restoreCompletedBoundary,
    restoreInProgressEpisode,
    getLatestProtectionBoundaryByDirection,
    getInProgressEpisodes,
    resetAll,
  };
}

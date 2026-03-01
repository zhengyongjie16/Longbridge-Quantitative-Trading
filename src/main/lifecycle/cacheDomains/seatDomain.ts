/**
 * 席位缓存域（CacheDomain: seat）
 *
 * 午夜清理：
 * - 重置所有监控标的的自动换仓状态（autoSymbolManager）
 * - 清空轮证列表缓存
 * - 清空所有席位绑定（保留 lastSwitchAt / lastSearchAt 时间戳，重置 lastSeatReadyAt）
 * - 同步席位快照到各 MonitorContext
 *
 * 开盘重建：
 * - 席位在统一开盘重建流水线（loadTradingDayRuntimeSnapshot）中重建，此处为空操作
 */
import { logger } from '../../../utils/logger/index.js';
import type { MonitorContext } from '../../../types/state.js';
import type { MultiMonitorTradingConfig } from '../../../types/config.js';
import type { SeatState, SymbolRegistry } from '../../../types/seat.js';
import type { CacheDomain, LifecycleContext } from '../types.js';
import type { SeatDomainDeps } from './types.js';

/** 基于旧席位状态构造空席位，保留 lastSwitchAt / lastSearchAt 时间戳并重置 lastSeatReadyAt */
function buildEmptySeatState(previous: SeatState): SeatState {
  return {
    symbol: null,
    status: 'EMPTY',
    lastSwitchAt: previous.lastSwitchAt ?? null,
    lastSearchAt: previous.lastSearchAt ?? null,
    lastSeatReadyAt: null,
    callPrice: null,
    searchFailCountToday: 0,
    frozenTradingDayKey: null,
  };
}

/** 清空所有监控标的的多空席位绑定，并刷新席位版本号，返回变更的席位数量 */
function clearAllSeatBindings(
  tradingConfig: MultiMonitorTradingConfig,
  symbolRegistry: SymbolRegistry,
): number {
  let changed = 0;
  for (const monitorConfig of tradingConfig.monitors) {
    for (const direction of ['LONG', 'SHORT'] as const) {
      const previous = symbolRegistry.getSeatState(monitorConfig.monitorSymbol, direction);
      symbolRegistry.updateSeatState(
        monitorConfig.monitorSymbol,
        direction,
        buildEmptySeatState(previous),
      );
      symbolRegistry.bumpSeatVersion(monitorConfig.monitorSymbol, direction);
      changed += 1;
    }
  }
  return changed;
}

/** 将 symbolRegistry 中的最新席位状态和版本号同步到各 MonitorContext 快照 */
function syncMonitorSeatSnapshots(
  monitorContexts: ReadonlyMap<string, MonitorContext>,
  symbolRegistry: SymbolRegistry,
): void {
  for (const monitorContext of monitorContexts.values()) {
    const monitorSymbol = monitorContext.config.monitorSymbol;
    monitorContext.seatState = {
      long: symbolRegistry.getSeatState(monitorSymbol, 'LONG'),
      short: symbolRegistry.getSeatState(monitorSymbol, 'SHORT'),
    };

    monitorContext.seatVersion = {
      long: symbolRegistry.getSeatVersion(monitorSymbol, 'LONG'),
      short: symbolRegistry.getSeatVersion(monitorSymbol, 'SHORT'),
    };
  }
}

/**
 * 创建席位缓存域。
 * 午夜清理时重置自动换标状态、清空轮证缓存与席位绑定并同步到各 MonitorContext；开盘重建由统一流水线负责，本域为空操作。
 *
 * @param deps 依赖注入，包含 tradingConfig、symbolRegistry、monitorContexts、warrantListCache
 * @returns 实现 CacheDomain 的席位域实例
 */
export function createSeatDomain(deps: SeatDomainDeps): CacheDomain {
  const { tradingConfig, symbolRegistry, monitorContexts, warrantListCache } = deps;
  return {
    midnightClear(_ctx: LifecycleContext): void {
      for (const monitorContext of monitorContexts.values()) {
        monitorContext.autoSymbolManager.resetAllState();
      }

      warrantListCache.clear();
      const changedSeats = clearAllSeatBindings(tradingConfig, symbolRegistry);
      syncMonitorSeatSnapshots(monitorContexts, symbolRegistry);

      logger.info(`[Lifecycle][seat] 午夜清理完成: seats=${changedSeats}`);
    },
    openRebuild(_ctx: LifecycleContext): void {
      // 席位在统一开盘重建流水线中重建
    },
  };
}

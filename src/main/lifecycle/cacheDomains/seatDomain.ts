import { logger } from '../../../utils/logger/index.js';
import type { MultiMonitorTradingConfig, SeatState, SymbolRegistry, MonitorContext } from '../../../types/index.js';
import type { CacheDomain, LifecycleContext } from '../types.js';
import type { SeatDomainDeps } from './types.js';

function buildEmptySeatState(previous: SeatState): SeatState {
  return {
    symbol: null,
    status: 'EMPTY',
    lastSwitchAt: previous.lastSwitchAt ?? null,
    lastSearchAt: previous.lastSearchAt ?? null,
    callPrice: null,
  };
}

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

export function createSeatDomain(deps: SeatDomainDeps): CacheDomain {
  const { tradingConfig, symbolRegistry, monitorContexts, warrantListCache } = deps;
  return {
    name: 'seat',
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

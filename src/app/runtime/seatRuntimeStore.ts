/**
 * 席位运行态 Store
 *
 * 职责：
 * - 作为席位状态与版本号的唯一真相源
 * - 为 startup/lifecycle/auto-symbol 提供统一的 seat 读写入口
 * - 为 legacy SymbolRegistry facade 提供兼容适配
 */
import type { MonitorConfig } from '../../types/config.js';
import type { SeatState, SeatStatus } from '../../types/seat.js';
import type {
  SeatRuntimeDirectionEntry,
  SeatRuntimeEntry,
  SeatRuntimeState,
  SeatRuntimeStore,
} from './types.js';

function createSeatState(symbol: string | null, status: SeatStatus): SeatState {
  return {
    symbol,
    status,
    lastSwitchAt: null,
    lastSearchAt: null,
    lastSeatReadyAt: null,
    callPrice: null,
    searchFailCountToday: 0,
    frozenTradingDayKey: null,
  };
}

function createSeatDirectionEntry(symbol: string | null, status: SeatStatus): SeatRuntimeDirectionEntry {
  return {
    state: createSeatState(symbol, status),
    version: 1,
  };
}

function createSeatEntry(monitor: MonitorConfig): SeatRuntimeEntry {
  const autoSearchEnabled = monitor.autoSearchConfig.autoSearchEnabled;
  return {
    long: autoSearchEnabled
      ? createSeatDirectionEntry(null, 'EMPTY')
      : createSeatDirectionEntry(monitor.longSymbol, 'READY'),
    short: autoSearchEnabled
      ? createSeatDirectionEntry(null, 'EMPTY')
      : createSeatDirectionEntry(monitor.shortSymbol, 'READY'),
  };
}

function resolveSeatDirectionEntry(
  state: SeatRuntimeState,
  monitorSymbol: string,
  direction: 'LONG' | 'SHORT',
): SeatRuntimeDirectionEntry {
  const entry = state.entries.get(monitorSymbol);
  if (!entry) {
    throw new Error(`SeatRuntimeStore 未找到监控标的: ${monitorSymbol}`);
  }

  return direction === 'LONG' ? entry.long : entry.short;
}

function cloneSeatState(nextState: SeatState): SeatState {
  return {
    symbol: nextState.symbol,
    status: nextState.status,
    lastSwitchAt: nextState.lastSwitchAt ?? null,
    lastSearchAt: nextState.lastSearchAt ?? null,
    lastSeatReadyAt: nextState.lastSeatReadyAt ?? null,
    callPrice: nextState.callPrice ?? null,
    searchFailCountToday: nextState.searchFailCountToday,
    frozenTradingDayKey: nextState.frozenTradingDayKey,
  };
}

/**
 * 创建席位运行态 store。
 *
 * @param monitors 所有监控标的配置
 * @returns seat runtime store
 */
export function createSeatRuntimeStore(
  monitors: ReadonlyArray<MonitorConfig>,
): SeatRuntimeStore {
  const state: SeatRuntimeState = {
    entries: new Map(monitors.map((monitor) => [monitor.monitorSymbol, createSeatEntry(monitor)])),
  };

  return {
    getState: () => state,
    getSeatState: (monitorSymbol, direction) => {
      return resolveSeatDirectionEntry(state, monitorSymbol, direction).state;
    },
    getSeatVersion: (monitorSymbol, direction) => {
      return resolveSeatDirectionEntry(state, monitorSymbol, direction).version;
    },
    resolveSeatBySymbol: (symbol) => {
      if (!symbol) {
        return null;
      }

      for (const [monitorSymbol, entry] of state.entries) {
        if (entry.long.state.symbol === symbol) {
          return {
            monitorSymbol,
            direction: 'LONG',
            seatState: entry.long.state,
            seatVersion: entry.long.version,
          };
        }

        if (entry.short.state.symbol === symbol) {
          return {
            monitorSymbol,
            direction: 'SHORT',
            seatState: entry.short.state,
            seatVersion: entry.short.version,
          };
        }
      }

      return null;
    },
    setSeatState: (monitorSymbol, direction, nextState) => {
      const directionEntry = resolveSeatDirectionEntry(state, monitorSymbol, direction);
      directionEntry.state = cloneSeatState(nextState);
      return directionEntry.state;
    },
    bumpSeatVersion: (monitorSymbol, direction) => {
      const directionEntry = resolveSeatDirectionEntry(state, monitorSymbol, direction);
      directionEntry.version += 1;
      return directionEntry.version;
    },
  };
}

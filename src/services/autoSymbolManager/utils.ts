/**
 * 自动换标席位工具：初始化席位、版本号与状态查询。
 */
import type {
  MonitorConfig,
  Position,
  SeatState,
  SeatStatus,
  SymbolRegistry,
} from '../../types/index.js';
import type { SeatDirection, SeatEntry, SymbolSeatEntry } from './types.js';

/**
 * 检查席位是否就绪（有有效标的且状态为 READY）
 */
export function isSeatReady(
  seatState: SeatState | null | undefined,
): seatState is SeatState & { symbol: string } {
  if (!seatState) {
    return false;
  }
  if (seatState.status !== 'READY') {
    return false;
  }
  return typeof seatState.symbol === 'string' && seatState.symbol.length > 0;
}

/**
 * 检查信号版本是否匹配当前席位版本
 * 用于过滤过期信号，避免换标后执行旧席位的订单
 */
export function isSeatVersionMatch(
  signalVersion: number | null | undefined,
  currentVersion: number,
): boolean {
  return Number.isFinite(signalVersion) && signalVersion === currentVersion;
}

/**
 * 启动时优先使用已有持仓的标的，避免自动寻标覆盖现有仓位。
 */
export function resolveSeatOnStartup({
  autoSearchEnabled,
  candidateSymbol,
  configuredSymbol,
  positions,
}: {
  readonly autoSearchEnabled: boolean;
  readonly candidateSymbol: string | null;
  readonly configuredSymbol: string | null;
  readonly positions: ReadonlyArray<Position>;
}): string | null {
  if (!autoSearchEnabled) {
    return configuredSymbol ?? null;
  }
  if (!candidateSymbol) {
    return null;
  }
  const hasPosition = positions.some((position) => {
    return position.symbol === candidateSymbol && (position.quantity ?? 0) > 0;
  });
  return hasPosition ? candidateSymbol : null;
}

/** 创建席位状态对象 */
function createSeatState(symbol: string | null, status: SeatStatus): SeatState {
  return {
    symbol,
    status,
    lastSwitchAt: null,
    lastSearchAt: null,
    callPrice: null,
  };
}

/** 创建席位条目（包含状态和版本号） */
function createSeatEntry(symbol: string | null, status: SeatStatus): SeatEntry {
  return {
    state: createSeatState(symbol, status),
    version: 1,
  };
}

/**
 * 从注册表中解析指定监控标的与方向的席位条目。
 */
function resolveSeatEntry(
  registry: Map<string, SymbolSeatEntry>,
  monitorSymbol: string,
  direction: SeatDirection,
): SeatEntry {
  const entry = registry.get(monitorSymbol);
  if (!entry) {
    throw new Error(`SymbolRegistry 未找到监控标的: ${monitorSymbol}`);
  }
  return direction === 'LONG' ? entry.long : entry.short;
}

/**
 * 创建席位注册表并初始化多/空席位状态。
 */
export function createSymbolRegistry(
  monitors: ReadonlyArray<MonitorConfig>,
): SymbolRegistry {
  const registry = new Map<string, SymbolSeatEntry>();

  for (const monitor of monitors) {
    const autoSearchEnabled = monitor.autoSearchConfig.autoSearchEnabled;
    registry.set(monitor.monitorSymbol, {
      long: autoSearchEnabled
        ? createSeatEntry(null, 'EMPTY')
        : createSeatEntry(monitor.longSymbol, 'READY'),
      short: autoSearchEnabled
        ? createSeatEntry(null, 'EMPTY')
        : createSeatEntry(monitor.shortSymbol, 'READY'),
    });
  }

  return {
    getSeatState(monitorSymbol: string, direction: SeatDirection): SeatState {
      return resolveSeatEntry(registry, monitorSymbol, direction).state;
    },
    getSeatVersion(monitorSymbol: string, direction: SeatDirection): number {
      return resolveSeatEntry(registry, monitorSymbol, direction).version;
    },
    resolveSeatBySymbol(symbol: string): {
      monitorSymbol: string;
      direction: 'LONG' | 'SHORT';
      seatState: SeatState;
      seatVersion: number;
    } | null {
      if (!symbol) {
        return null;
      }
      for (const [monitorSymbol, entry] of registry) {
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
    updateSeatState(
      monitorSymbol: string,
      direction: SeatDirection,
      nextState: SeatState,
    ): SeatState {
      const seatEntry = resolveSeatEntry(registry, monitorSymbol, direction);
      seatEntry.state = {
        symbol: nextState.symbol,
        status: nextState.status,
        lastSwitchAt: nextState.lastSwitchAt ?? null,
        lastSearchAt: nextState.lastSearchAt ?? null,
        callPrice: nextState.callPrice ?? null,
      };
      return seatEntry.state;
    },
    bumpSeatVersion(monitorSymbol: string, direction: SeatDirection): number {
      const seatEntry = resolveSeatEntry(registry, monitorSymbol, direction);
      seatEntry.version += 1;
      return seatEntry.version;
    },
  };
}

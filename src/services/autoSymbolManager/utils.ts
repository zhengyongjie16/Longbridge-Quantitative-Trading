/**
 * 自动换标席位工具：初始化席位、版本号与状态查询。
 */
import type { MonitorConfig } from '../../types/config.js';
import type { Position } from '../../types/account.js';
import type { SeatState, SeatStatus, SymbolRegistry } from '../../types/seat.js';
import type { SeatEntry, SeatUnavailableReason, SymbolSeatEntry } from './types.js';

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
 * 检查席位是否当日冻结（frozenTradingDayKey 非 null 即冻结，midnight clear 重置）
 */
export function isSeatFrozenToday(seatState: SeatState): boolean {
  return seatState.frozenTradingDayKey != null;
}

/**
 * 计算下一次寻标失败后的失败计数与冻结状态。
 *
 * 统一的失败计数与冻结规则：
 * - 每次失败将 searchFailCountToday + 1
 * - 当失败次数达到 maxSearchFailuresPerDay 时，当日冻结席位
 * - 冻结后保留已存在的 frozenTradingDayKey（若未能获取当日 key，则不覆盖）
 */
export function resolveNextSearchFailureState(params: {
  readonly currentSeat: SeatState;
  readonly hkDateKey: string | null;
  readonly maxSearchFailuresPerDay: number;
}): {
  readonly nextFailCount: number;
  readonly frozenTradingDayKey: string | null;
  readonly shouldFreeze: boolean;
} {
  const nextFailCount = params.currentSeat.searchFailCountToday + 1;
  const shouldFreeze = nextFailCount >= params.maxSearchFailuresPerDay;
  const frozenTradingDayKey = shouldFreeze
    ? params.hkDateKey ?? params.currentSeat.frozenTradingDayKey
    : params.currentSeat.frozenTradingDayKey;

  return {
    nextFailCount,
    frozenTradingDayKey,
    shouldFreeze,
  };
}

/**
 * 解析席位不可用原因（席位就绪时返回 null）
 */
export function resolveSeatUnavailableReason(
  seatState: SeatState,
): SeatUnavailableReason | null {
  if (seatState.status === 'READY' && typeof seatState.symbol === 'string' && seatState.symbol.length > 0) {
    return null;
  }
  if (seatState.status === 'SEARCHING') {
    return 'SEAT_SEARCHING';
  }
  if (seatState.status === 'SWITCHING') {
    return 'SEAT_SWITCHING';
  }
  if (isSeatFrozenToday(seatState)) {
    return 'SEAT_FROZEN_TODAY';
  }
  return 'SEAT_EMPTY';
}

const SEAT_UNAVAILABLE_REASON_MAP: Readonly<Record<SeatUnavailableReason, string>> = {
  SEAT_EMPTY: '席位为空',
  SEAT_FROZEN_TODAY: '席位已冻结（当日）',
  SEAT_SEARCHING: '席位正在寻标',
  SEAT_SWITCHING: '席位正在换标',
};

/**
 * 将席位不可用原因格式化为日志文案
 */
export function formatSeatUnavailableReason(reason: SeatUnavailableReason): string {
  return SEAT_UNAVAILABLE_REASON_MAP[reason];
}

/**
 * 从非就绪席位状态获取格式化的不可用原因文案。
 * 前提：调用方已确认 isSeatReady(seatState) === false。
 */
export function describeSeatUnavailable(seatState: SeatState): string {
  const reason = resolveSeatUnavailableReason(seatState);
  return reason == null ? '席位不可用' : SEAT_UNAVAILABLE_REASON_MAP[reason];
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
    searchFailCountToday: 0,
    frozenTradingDayKey: null,
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
  direction: 'LONG' | 'SHORT',
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
    getSeatState(monitorSymbol: string, direction: 'LONG' | 'SHORT'): SeatState {
      return resolveSeatEntry(registry, monitorSymbol, direction).state;
    },
    getSeatVersion(monitorSymbol: string, direction: 'LONG' | 'SHORT'): number {
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
      direction: 'LONG' | 'SHORT',
      nextState: SeatState,
    ): SeatState {
      const seatEntry = resolveSeatEntry(registry, monitorSymbol, direction);
      seatEntry.state = {
        symbol: nextState.symbol,
        status: nextState.status,
        lastSwitchAt: nextState.lastSwitchAt ?? null,
        lastSearchAt: nextState.lastSearchAt ?? null,
        callPrice: nextState.callPrice ?? null,
        searchFailCountToday: nextState.searchFailCountToday,
        frozenTradingDayKey: nextState.frozenTradingDayKey,
      };
      return seatEntry.state;
    },
    bumpSeatVersion(monitorSymbol: string, direction: 'LONG' | 'SHORT'): number {
      const seatEntry = resolveSeatEntry(registry, monitorSymbol, direction);
      seatEntry.version += 1;
      return seatEntry.version;
    },
  };
}

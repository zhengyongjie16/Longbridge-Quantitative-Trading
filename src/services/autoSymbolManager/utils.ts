import type { MonitorConfig } from '../../types/config.js';
import type { Position } from '../../types/account.js';
import type { SeatState, SymbolRegistry } from '../../types/seat.js';
import type { SeatUnavailableReason } from './types.js';
import type { SeatRuntimeStore } from '../../app/runtime/types.js';
import { createSeatRuntimeStore } from '../../app/runtime/seatRuntimeStore.js';

/**
 * 检查席位是否就绪（有有效标的且状态为 READY）
 * @param seatState 席位状态，可为 null 或 undefined
 * @returns 席位就绪时返回 true，并收窄类型为含 symbol 字符串的 SeatState
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
 * @param seatState 席位状态
 * @returns 当日冻结时返回 true
 */
export function isSeatFrozenToday(seatState: SeatState): boolean {
  return seatState.frozenTradingDayKey !== null;
}

/**
 * 计算下一次寻标失败后的失败计数与冻结状态。
 *
 * 统一的失败计数与冻结规则：
 * - 每次失败将 searchFailCountToday + 1
 * - 当失败次数达到 maxSearchFailuresPerDay 时，当日冻结席位
 * - 冻结后保留已存在的 frozenTradingDayKey（若未能获取当日 key，则不覆盖）
 * @param params.currentSeat 当前席位状态
 * @param params.hkDateKey 当前香港日期键，用于写入冻结标记
 * @param params.maxSearchFailuresPerDay 当日最大允许失败次数
 * @returns 下次失败计数、冻结日期键与是否触发冻结
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
    ? (params.hkDateKey ?? params.currentSeat.frozenTradingDayKey)
    : params.currentSeat.frozenTradingDayKey;

  return {
    nextFailCount,
    frozenTradingDayKey,
    shouldFreeze,
  };
}

/**
 * 解析席位不可用原因（席位就绪时返回 null）
 * @param seatState 席位状态
 * @returns 不可用原因枚举值，席位就绪时返回 null
 */
function resolveSeatUnavailableReason(seatState: SeatState): SeatUnavailableReason | null {
  if (
    seatState.status === 'READY' &&
    typeof seatState.symbol === 'string' &&
    seatState.symbol.length > 0
  ) {
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
 * 从非就绪席位状态获取格式化的不可用原因文案。
 * 前提：调用方已确认 isSeatReady(seatState) === false。
 * @param seatState 席位状态
 * @returns 不可用原因的中文描述字符串
 */
export function describeSeatUnavailable(seatState: SeatState): string {
  const reason = resolveSeatUnavailableReason(seatState);
  return reason === null ? '席位不可用' : SEAT_UNAVAILABLE_REASON_MAP[reason];
}

/**
 * 检查信号版本是否匹配当前席位版本
 * 用于过滤过期信号，避免换标后执行旧席位的订单
 * @param signalVersion 信号携带的席位版本号
 * @param currentVersion 当前席位版本号
 * @returns 版本匹配时返回 true
 */
export function isSeatVersionMatch(
  signalVersion: number | null | undefined,
  currentVersion: number,
): boolean {
  return Number.isFinite(signalVersion) && signalVersion === currentVersion;
}

/**
 * 启动时优先使用已有持仓的标的，避免自动寻标覆盖现有仓位。
 * @param params.autoSearchEnabled 是否启用自动寻标
 * @param params.candidateSymbol 候选标的代码
 * @param params.configuredSymbol 配置文件中指定的标的代码
 * @param params.positions 当前持仓列表
 * @returns 启动时应使用的标的代码，无合适标的时返回 null
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
    return position.symbol === candidateSymbol && position.quantity > 0;
  });
  return hasPosition ? candidateSymbol : null;
}

/**
 * 基于 SeatRuntimeStore 创建 legacy SymbolRegistry facade。
 *
 * @param seatRuntimeStore 席位运行态 store
 * @returns 兼容旧调用链的 SymbolRegistry
 */
export function createSymbolRegistryFromSeatRuntimeStore(
  seatRuntimeStore: SeatRuntimeStore,
): SymbolRegistry {
  return {
    getSeatState: (monitorSymbol, direction) => {
      return seatRuntimeStore.getSeatState(monitorSymbol, direction);
    },
    getSeatVersion: (monitorSymbol, direction) => {
      return seatRuntimeStore.getSeatVersion(monitorSymbol, direction);
    },
    resolveSeatBySymbol: (symbol) => {
      return seatRuntimeStore.resolveSeatBySymbol(symbol);
    },
    updateSeatState: (monitorSymbol, direction, nextState) => {
      return seatRuntimeStore.setSeatState(monitorSymbol, direction, nextState);
    },
    bumpSeatVersion: (monitorSymbol, direction) => {
      return seatRuntimeStore.bumpSeatVersion(monitorSymbol, direction);
    },
  };
}

/**
 * 创建席位注册表并初始化多/空席位状态。
 * @param monitors 所有监控标的配置列表
 * @returns 实现了 SymbolRegistry 接口的注册表对象
 */
export function createSymbolRegistry(monitors: ReadonlyArray<MonitorConfig>): SymbolRegistry {
  return createSymbolRegistryFromSeatRuntimeStore(createSeatRuntimeStore(monitors));
}

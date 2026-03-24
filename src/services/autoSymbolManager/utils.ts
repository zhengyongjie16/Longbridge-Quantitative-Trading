/**
 * 自动标的管理工具模块
 *
 * 职责：
 * - 提供席位冻结失败计数、信号席位校验与失败原因格式化能力
 * - 提供席位启动恢复与 SymbolRegistry 构建能力
 */
import type { MonitorConfig } from '../../types/config.js';
import type { Position } from '../../types/account.js';
import type { SeatState, SeatStatus, SymbolRegistry } from '../../types/seat.js';
import { isSeatActive, isSeatVersionMatch } from '../../utils/seat/guards.js';
import type {
  SeatEntry,
  SeatUnavailableReason,
  SignalSeatValidationResult,
  SymbolSeatEntry,
  ValidateSignalSeatParams,
} from './types.js';

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
 * 解析席位不可用原因（席位已激活时返回 null）
 * @param seatState 席位状态
 * @returns 不可用原因枚举值，席位已激活时返回 null
 */
function resolveSeatUnavailableReason(seatState: SeatState): SeatUnavailableReason | null {
  if (isSeatActive(seatState)) {
    return null;
  }

  if (seatState.status === 'SEARCHING') {
    return 'SEAT_SEARCHING';
  }

  if (seatState.status === 'SWITCHING') {
    return 'SEAT_SWITCHING';
  }

  if (seatState.status === 'ACTIVATING') {
    return 'SEAT_ACTIVATING';
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
  SEAT_ACTIVATING: '席位正在激活',
};

/**
 * 从非激活席位状态获取格式化的不可用原因文案。
 * 前提：调用方已确认 isSeatActive(seatState) === false。
 * @param seatState 席位状态
 * @returns 不可用原因的中文描述字符串
 */
export function describeSeatUnavailable(seatState: SeatState): string {
  const reason = resolveSeatUnavailableReason(seatState);
  return reason === null ? '席位不可用' : SEAT_UNAVAILABLE_REASON_MAP[reason];
}

function resolveSignalDirection(
  action: ValidateSignalSeatParams['signal']['action'],
): 'LONG' | 'SHORT' {
  switch (action) {
    case 'BUYCALL':
    case 'SELLCALL': {
      return 'LONG';
    }

    case 'BUYPUT':
    case 'SELLPUT': {
      return 'SHORT';
    }

    case 'HOLD': {
      throw new Error('HOLD 信号不支持席位校验');
    }

    default: {
      throw new Error(`不支持的席位校验信号动作: ${String(action)}`);
    }
  }
}

/**
 * 校验信号是否仍绑定到当前席位。
 * 默认行为：按 action 推导方向后，依次校验席位 ACTIVE、席位版本匹配与席位标的一致性。
 *
 * @param params 校验所需的 monitorSymbol、signal 与 symbolRegistry
 * @returns 校验结果；成功时返回收窄后的就绪 seatState，失败时返回失败原因
 */
export function validateSignalSeat(params: ValidateSignalSeatParams): SignalSeatValidationResult {
  const direction = resolveSignalDirection(params.signal.action);
  const seatState = params.symbolRegistry.getSeatState(params.monitorSymbol, direction);
  const seatVersion = params.symbolRegistry.getSeatVersion(params.monitorSymbol, direction);
  if (!isSeatActive(seatState)) {
    return {
      valid: false,
      direction,
      reason: 'SEAT_UNAVAILABLE',
      seatState,
      seatVersion,
    };
  }

  if (!isSeatVersionMatch(params.signal.seatVersion, seatVersion)) {
    return {
      valid: false,
      direction,
      reason: 'SEAT_VERSION_MISMATCH',
      seatState,
      seatVersion,
    };
  }

  if (params.signal.symbol !== seatState.symbol) {
    return {
      valid: false,
      direction,
      reason: 'SEAT_SYMBOL_MISMATCH',
      seatState,
      seatVersion,
    };
  }

  return {
    valid: true,
    direction,
    seatState,
    seatVersion,
  };
}

/**
 * 格式化信号席位校验失败原因。
 * 默认行为：席位不可用时复用席位状态描述，其余失败返回统一中文原因。
 *
 * @param result validateSignalSeat 返回的失败结果
 * @returns 可直接用于日志的中文失败原因
 */
export function describeSignalSeatValidationFailure(
  result: Extract<SignalSeatValidationResult, { valid: false }>,
): string {
  switch (result.reason) {
    case 'SEAT_UNAVAILABLE': {
      return describeSeatUnavailable(result.seatState);
    }

    case 'SEAT_VERSION_MISMATCH': {
      return '席位版本不匹配';
    }

    case 'SEAT_SYMBOL_MISMATCH': {
      return '标的已切换';
    }

    default: {
      throw new Error(`未知的信号席位校验失败原因: ${String(result.reason)}`);
    }
  }
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
 * 创建席位状态对象（内部工厂函数）
 * @param symbol 交易标的代码，null 表示未绑定
 * @param status 席位状态（EMPTY/SEARCHING/SWITCHING/ACTIVATING/ACTIVE）
 * @returns 初始化的席位状态对象
 */
function createSeatState(symbol: string | null, status: SeatStatus): SeatState {
  return {
    symbol,
    status,
    lastSwitchAt: null,
    lastSearchAt: null,
    lastSeatActivatedAt: null,
    callPrice: null,
    searchFailCountToday: 0,
    frozenTradingDayKey: null,
  };
}

/**
 * 创建席位条目（内部工厂函数）
 * @param symbol 交易标的代码，null 表示未绑定
 * @param status 席位状态（EMPTY/SEARCHING/SWITCHING/ACTIVATING/ACTIVE）
 * @returns 包含状态和版本号的席位条目，初始版本号为 1
 */
function createSeatEntry(symbol: string | null, status: SeatStatus): SeatEntry {
  return {
    state: createSeatState(symbol, status),
    version: 1,
  };
}

/**
 * 从注册表中解析指定监控标的与方向的席位条目（内部辅助函数）
 * @param registry 席位注册表
 * @param monitorSymbol 监控标的代码
 * @param direction 方向（LONG 或 SHORT）
 * @returns 对应方向的席位条目
 * @throws 当监控标的不存在于注册表时抛出错误
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
 * @param monitors 所有监控标的配置列表
 * @returns 实现了 SymbolRegistry 接口的注册表对象
 */
export function createSymbolRegistry(monitors: ReadonlyArray<MonitorConfig>): SymbolRegistry {
  const registry = new Map<string, SymbolSeatEntry>();

  for (const monitor of monitors) {
    const autoSearchEnabled = monitor.autoSearchConfig.autoSearchEnabled;
    registry.set(monitor.monitorSymbol, {
      long: autoSearchEnabled
        ? createSeatEntry(null, 'EMPTY')
        : createSeatEntry(monitor.longSymbol, 'ACTIVE'),
      short: autoSearchEnabled
        ? createSeatEntry(null, 'EMPTY')
        : createSeatEntry(monitor.shortSymbol, 'ACTIVE'),
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
        lastSeatActivatedAt: nextState.lastSeatActivatedAt ?? null,
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

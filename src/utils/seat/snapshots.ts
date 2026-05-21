import type { Quote } from '../../types/quote.js';
import type { SymbolRegistry, SeatState } from '../../types/seat.js';
import type { MonitorContextRuntimeSnapshot, MonitorContextSeatSnapshot } from './types.js';

/**
 * 解析可消费的 ACTIVE 席位标的代码。
 * 默认行为：仅当 seat 处于 ACTIVE 且 symbol 为非空字符串时返回 symbol，否则返回 null。
 *
 * @param seatState 席位状态
 * @returns 当前可消费的席位标的代码，或 null
 */
function resolveActiveSeatSymbol(seatState: SeatState): string | null {
  if (seatState.status !== 'ACTIVE') {
    return null;
  }

  return typeof seatState.symbol === 'string' && seatState.symbol.length > 0
    ? seatState.symbol
    : null;
}

/**
 * 解析单个监控标的的席位快照。
 * 默认行为：读取 symbolRegistry 中的多空席位状态与版本，并派生当前可消费的 ACTIVE 标的代码。
 *
 * @param monitorSymbol 监控标的代码
 * @param symbolRegistry 席位注册表
 * @returns 席位状态、版本与当前就绪标的代码快照
 */
export function resolveMonitorContextSeatSnapshot(
  monitorSymbol: string,
  symbolRegistry: SymbolRegistry,
): MonitorContextSeatSnapshot {
  const longSeatState = symbolRegistry.getSeatState(monitorSymbol, 'LONG');
  const shortSeatState = symbolRegistry.getSeatState(monitorSymbol, 'SHORT');
  return {
    seatState: {
      long: longSeatState,
      short: shortSeatState,
    },
    seatVersion: {
      long: symbolRegistry.getSeatVersion(monitorSymbol, 'LONG'),
      short: symbolRegistry.getSeatVersion(monitorSymbol, 'SHORT'),
    },
    longSymbol: resolveActiveSeatSymbol(longSeatState),
    shortSymbol: resolveActiveSeatSymbol(shortSeatState),
  };
}

/**
 * 解析单个监控标的的运行时快照。
 * 默认行为：基于席位快照与 quotesMap 派生 MonitorContext 所需的行情与名称字段。
 *
 * @param monitorSymbol 监控标的代码
 * @param symbolRegistry 席位注册表
 * @param quotesMap 标的 -> 行情 Map
 * @returns MonitorContext 所需的运行时派生快照
 */
export function resolveMonitorContextRuntimeSnapshot(
  monitorSymbol: string,
  symbolRegistry: SymbolRegistry,
  quotesMap: ReadonlyMap<string, Quote | null>,
): MonitorContextRuntimeSnapshot {
  const seatSnapshot = resolveMonitorContextSeatSnapshot(monitorSymbol, symbolRegistry);
  const { longSymbol, shortSymbol } = seatSnapshot;
  const longQuote = longSymbol ? (quotesMap.get(longSymbol) ?? null) : null;
  const shortQuote = shortSymbol ? (quotesMap.get(shortSymbol) ?? null) : null;
  const monitorQuote = quotesMap.get(monitorSymbol) ?? null;
  return {
    ...seatSnapshot,
    longQuote,
    shortQuote,
    monitorQuote,
    longSymbolName: longSymbol ? (longQuote?.name ?? longSymbol) : '',
    shortSymbolName: shortSymbol ? (shortQuote?.name ?? shortSymbol) : '',
    monitorSymbolName: monitorQuote?.name ?? monitorSymbol,
  };
}

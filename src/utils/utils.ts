import { ACCOUNT_CHANNEL_MAP } from '../constants/index.js';
import type { Quote } from '../types/quote.js';
import type { SymbolRegistry, SeatState } from '../types/seat.js';
import type { QueueClearResult } from '../types/queue.js';
import type { MonitorContextSeatSnapshot, MonitorContextRuntimeSnapshot } from './types.js';

function resolveReadySeatSymbol(seatState: SeatState): string | null {
  if (seatState.status !== 'READY') {
    return null;
  }

  return typeof seatState.symbol === 'string' && seatState.symbol.length > 0
    ? seatState.symbol
    : null;
}

/**
 * 解析单个监控标的的席位快照。
 * 默认行为：读取 symbolRegistry 中的多空席位状态与版本，并派生当前就绪标的代码。
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
    longSymbol: resolveReadySeatSymbol(longSeatState),
    shortSymbol: resolveReadySeatSymbol(shortSeatState),
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

/**
 * 判断运行时校验标的是否应跳过收集。
 * 默认行为：symbol 为空或已存在于 requiredSymbols 时返回 true（跳过）。
 *
 * @param symbol 当前待收集标的代码
 * @param requiredSymbols 已收录的必选标的集合
 * @returns true 表示应跳过，false 表示继续收集
 */
export function shouldSkipRuntimeValidationSymbol(
  symbol: string | null,
  requiredSymbols: ReadonlySet<string>,
): boolean {
  return !symbol || requiredSymbols.has(symbol);
}

/**
 * 汇总队列清理结果中的移除总数。
 * 默认行为：按 removedDelayed、removedBuy、removedSell、removedMonitorTasks 相加。
 *
 * @param result 队列清理结果
 * @returns 本次清理移除的任务总数
 */
export function getQueueClearTotalRemoved(result: QueueClearResult): number {
  return (
    result.removedDelayed + result.removedBuy + result.removedSell + result.removedMonitorTasks
  );
}

/**
 * 解析布尔环境变量字符串。
 * 默认行为：无法识别时返回 null。
 *
 * @param value 环境变量原始字符串
 * @returns true/false 或 null
 */
export function parseBooleanEnv(value: string | undefined): boolean | null {
  if (value === undefined) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') {
    return true;
  }

  if (normalized === 'false' || normalized === '0') {
    return false;
  }

  return null;
}

/**
 * 格式化数字，保留指定小数位数。
 * 默认行为：num 为 null/undefined 或非有限数时返回 "-"；digits 默认为 2。
 *
 * @param num 要格式化的数字
 * @param digits 保留的小数位数，默认 2
 * @returns 格式化后的字符串，无效时返回 "-"
 */
export function formatNumber(num: number | null | undefined, digits: number = 2): string {
  if (num === null || num === undefined) {
    return '-';
  }

  return Number.isFinite(num) ? num.toFixed(digits) : String(num);
}

/**
 * 格式化账户渠道显示名称。
 * 默认行为：accountChannel 为空或非字符串时返回「未知账户」。
 *
 * @param accountChannel 账户渠道代码
 * @returns 映射后的显示名称，无效时返回「未知账户」
 */
export function formatAccountChannel(accountChannel: string | null | undefined): string {
  if (!accountChannel || typeof accountChannel !== 'string') {
    return '未知账户';
  }

  const key = accountChannel.toLowerCase();
  return ACCOUNT_CHANNEL_MAP[key] ?? accountChannel;
}

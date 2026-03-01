import type { Position } from '../types/account.js';
import type { SymbolRegistry } from '../types/seat.js';
import type { LastState } from '../types/state.js';
import type { Trader } from '../types/services.js';
import { TIME } from '../constants/index.js';
import { logger } from '../utils/logger/index.js';
import { formatError } from '../utils/error/index.js';

/**
 * 异步延迟指定毫秒数，无效值时使用 1000ms。
 *
 * @param ms 延迟毫秒数
 * @returns Promise，延迟结束后 resolve
 */
export async function sleep(ms: number): Promise<void> {
  const delay = ms;
  if (!Number.isFinite(delay) || delay < 0) {
    logger.warn(`[sleep] 无效的延迟时间 ${ms}，使用默认值 ${TIME.MILLISECONDS_PER_SECOND}ms`);
    return new Promise<void>((resolve) => {
      setTimeout(resolve, TIME.MILLISECONDS_PER_SECOND);
    });
  }
  return new Promise<void>((resolve) => {
    setTimeout(resolve, delay);
  });
}

/**
 * 刷新账户与持仓缓存（仅数据拉取，不做行情订阅）。默认行为：仅当 lastState.cachedAccount 为空时调用
 * trader.getAccountSnapshot 与 getStockPositions，否则直接使用已有缓存；成功后更新 lastState 的
 * cachedAccount、cachedPositions 与 positionCache，失败时仅打日志不抛错。
 *
 * @param trader Trader 实例，用于拉取账户与持仓
 * @param lastState 状态对象，用于读取/更新缓存（cachedAccount、cachedPositions、positionCache）
 * @returns Promise<void>，无返回值；拉取失败时不抛错
 */
export async function refreshAccountAndPositions(
  trader: Trader,
  lastState: LastState,
): Promise<void> {
  try {
    const hasCache = lastState.cachedAccount !== null;
    let account = lastState.cachedAccount;
    let positions = lastState.cachedPositions;
    if (!hasCache) {
      const [freshAccount, freshPositions] = await Promise.all([
        trader.getAccountSnapshot().catch((err: unknown) => {
          logger.warn('获取账户信息失败', formatError(err));
          return null;
        }),
        trader.getStockPositions().catch((err: unknown) => {
          logger.warn('获取股票仓位失败', formatError(err));
          return [];
        }),
      ]);
      account = freshAccount;
      positions = freshPositions;
      lastState.cachedAccount = account;
      lastState.cachedPositions = positions;
      lastState.positionCache.update(positions);
    }
  } catch (err) {
    logger.warn('获取账户和持仓信息失败', formatError(err));
  }
}

/**
 * 收集运行时需要获取行情的标的代码集合（监控标的 + 席位占用标的 + 持仓标的 + 订单持有标的）。默认行为：合并去重后返回 Set。
 *
 * @param monitorConfigs 监控配置数组（monitorSymbol、longSymbol、shortSymbol）
 * @param symbolRegistry 标的注册表，用于解析席位当前占用标的
 * @param positions 当前持仓数组
 * @param orderHoldSymbols 订单持有标的集合
 * @returns 需要拉取行情的标的代码集合
 */
export function collectRuntimeQuoteSymbols(
  monitorConfigs: ReadonlyArray<{
    readonly monitorSymbol: string;
    readonly longSymbol: string;
    readonly shortSymbol: string;
  }>,
  symbolRegistry: SymbolRegistry,
  positions: ReadonlyArray<Position>,
  orderHoldSymbols: ReadonlySet<string>,
): Set<string> {
  const symbols = collectAllQuoteSymbols(monitorConfigs, symbolRegistry);
  for (const position of positions) {
    if (position.symbol) {
      symbols.add(position.symbol);
    }
  }
  for (const symbol of orderHoldSymbols) {
    if (symbol) {
      symbols.add(symbol);
    }
  }
  return symbols;
}

/**
 * 计算两个行情标的集合的增量（新增与移除）。默认行为：遍历比较后返回 added/removed 数组。
 *
 * @param prevSymbols 上一次的标的集合
 * @param nextSymbols 当前需要的标的集合
 * @returns 新增标的数组（added）与移除标的数组（removed）
 */
export function diffQuoteSymbols(
  prevSymbols: ReadonlySet<string>,
  nextSymbols: ReadonlySet<string>,
): { added: ReadonlyArray<string>; removed: ReadonlyArray<string> } {
  const added: string[] = [];
  const removed: string[] = [];
  for (const symbol of nextSymbols) {
    if (!prevSymbols.has(symbol)) {
      added.push(symbol);
    }
  }
  for (const symbol of prevSymbols) {
    if (!nextSymbols.has(symbol)) {
      removed.push(symbol);
    }
  }
  return { added, removed };
}

/**
 * 收集所有需要获取行情的标的代码（监控标的 + 席位占用标的），用于主循环一次性批量拉取行情。
 *
 * @param monitorConfigs 监控配置数组（monitorSymbol、longSymbol、shortSymbol）
 * @param symbolRegistry 标的注册表，可选；传入时从席位状态解析做多/做空占用标的并加入集合
 * @returns 需要拉取行情的标的代码集合
 */
function collectAllQuoteSymbols(
  monitorConfigs: ReadonlyArray<{
    readonly monitorSymbol: string;
    readonly longSymbol: string;
    readonly shortSymbol: string;
  }>,
  symbolRegistry?: SymbolRegistry | null,
): Set<string> {
  const symbols = new Set<string>();
  for (const config of monitorConfigs) {
    symbols.add(config.monitorSymbol);
    if (!symbolRegistry) {
      continue;
    }
    const longSeat = symbolRegistry.getSeatState(config.monitorSymbol, 'LONG');
    const shortSeat = symbolRegistry.getSeatState(config.monitorSymbol, 'SHORT');
    if (longSeat.symbol) {
      symbols.add(longSeat.symbol);
    }
    if (shortSeat.symbol) {
      symbols.add(shortSeat.symbol);
    }
  }
  return symbols;
}

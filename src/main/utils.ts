import type { Position } from '../types/account.js';
import type { SymbolRegistry } from '../types/seat.js';
import type { LastState } from '../types/state.js';
import type { Trader } from '../types/services.js';
import { logger } from '../utils/logger/index.js';
import { formatError } from '../utils/error/index.js';
import { isExternalApiRequestError, isProgramError } from '../utils/apiFailure/index.js';

/**
 * 刷新账户与持仓缓存（仅数据拉取，不做行情订阅）。默认行为：仅当 lastState.cachedAccount 为空时调用
 * trader.getAccountSnapshot 与 getStockPositions，否则直接使用已有缓存；成功后原子更新 lastState 的
 * cachedAccount、cachedPositions 与 positionCache。账户或持仓任一失败都会抛错，避免把未知快照写成空事实。
 *
 * @param trader Trader 实例，用于拉取账户与持仓
 * @param lastState 状态对象，用于读取/更新缓存（cachedAccount、cachedPositions、positionCache）
 * @returns Promise<void>，无返回值；拉取失败时抛错
 */
export async function refreshAccountAndPositions(
  trader: Trader,
  lastState: LastState,
): Promise<void> {
  if (lastState.cachedAccount !== null) {
    return;
  }

  let freshAccount: Awaited<ReturnType<Trader['getAccountSnapshot']>>;
  let freshPositions: Awaited<ReturnType<Trader['getStockPositions']>>;
  try {
    [freshAccount, freshPositions] = await Promise.all([
      trader.getAccountSnapshot(),
      trader.getStockPositions(),
    ]);
  } catch (err) {
    const message = `无法刷新账户和持仓信息: ${formatError(err)}`;
    logger.warn(message);
    if (isProgramError(err)) {
      throw err;
    }

    if (isExternalApiRequestError(err)) {
      throw err;
    }

    throw new Error(message, { cause: err });
  }

  lastState.cachedAccount = freshAccount;
  lastState.cachedPositions = freshPositions;
  lastState.positionCache.update(freshPositions);
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
 * 收集所有需要获取行情的标的代码（监控标的 + 席位占用标的），供运行时快照与订阅链路批量拉取行情。
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

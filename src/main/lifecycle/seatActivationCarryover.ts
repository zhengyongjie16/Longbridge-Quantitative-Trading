/**
 * seatActivationCarryover 模块
 *
 * 职责：
 * - 在午夜清理前暂存前一交易日各席位的激活基线
 * - 在开盘重建成功后，仅对恢复为同一 symbol 的席位恢复激活基线
 * - 避免把旧 symbol 的周期换标累计交易时长误带到新 symbol
 */
import { isSeatActive } from '../../utils/seat/guards.js';
import type { MultiMonitorTradingConfig } from '../../types/config.js';
import type { SymbolRegistry } from '../../types/seat.js';

const seatActivationCarryoverByRegistry = new WeakMap<
  SymbolRegistry,
  ReadonlyMap<
    string,
    Readonly<{
      symbol: string;
      activatedAtMs: number;
    }>
  >
>();

/**
 * 构造席位方向键。
 *
 * @param monitorSymbol 监控标的
 * @param direction 席位方向
 * @returns `${monitorSymbol}:${direction}` 形式的稳定键
 */
function buildSeatDirectionKey(monitorSymbol: string, direction: 'LONG' | 'SHORT'): string {
  return `${monitorSymbol}:${direction}`;
}

/**
 * 在午夜清理前捕获仍然有效的席位激活基线。
 *
 * 仅保留当前仍处于 ACTIVE 且 activation 时间有效的席位；
 * 非 ACTIVE / 无 symbol / 无 activation 时间的席位都不进入快照。
 *
 * @param params 交易配置与席位注册表
 */
export function captureSeatActivationCarryover(params: {
  readonly tradingConfig: MultiMonitorTradingConfig;
  readonly symbolRegistry: SymbolRegistry;
}): void {
  const { tradingConfig, symbolRegistry } = params;
  const existingSnapshot = seatActivationCarryoverByRegistry.get(symbolRegistry);
  const nextSnapshot = new Map<
    string,
    Readonly<{
      symbol: string;
      activatedAtMs: number;
    }>
  >();
  for (const monitorConfig of tradingConfig.monitors) {
    for (const direction of ['LONG', 'SHORT'] as const) {
      const seatState = symbolRegistry.getSeatState(monitorConfig.monitorSymbol, direction);
      if (!isSeatActive(seatState)) {
        continue;
      }

      if (
        seatState.lastSeatActivatedAt === null ||
        !Number.isFinite(seatState.lastSeatActivatedAt)
      ) {
        continue;
      }

      nextSnapshot.set(buildSeatDirectionKey(monitorConfig.monitorSymbol, direction), {
        symbol: seatState.symbol,
        activatedAtMs: seatState.lastSeatActivatedAt,
      });
    }
  }

  if (nextSnapshot.size === 0 && existingSnapshot !== undefined) {
    return;
  }

  seatActivationCarryoverByRegistry.set(symbolRegistry, nextSnapshot);
}

/**
 * 读取某个重建后席位可复用的激活基线。
 *
 * 只有在 midnight 之前保存过快照，且当前重建出的 symbol 与快照中的 symbol 完全一致时，
 * 才认为这是同一席位跨日延续，允许恢复原激活时间。
 *
 * @param params 席位注册表、监控标的、方向与当前 symbol
 * @returns 可恢复的激活时间；不满足条件时返回 null
 */
export function resolveSeatActivationCarryover(params: {
  readonly symbolRegistry: SymbolRegistry;
  readonly monitorSymbol: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly symbol: string;
}): number | null {
  const { symbolRegistry, monitorSymbol, direction, symbol } = params;
  const snapshot = seatActivationCarryoverByRegistry.get(symbolRegistry);
  if (snapshot === undefined) {
    return null;
  }

  const entry = snapshot.get(buildSeatDirectionKey(monitorSymbol, direction));
  if (entry?.symbol !== symbol) {
    return null;
  }

  return entry.activatedAtMs;
}

/**
 * 清空当前 runtime 的跨日席位激活基线快照。
 *
 * @param symbolRegistry 席位注册表
 */
export function clearSeatActivationCarryover(symbolRegistry: SymbolRegistry): void {
  seatActivationCarryoverByRegistry.delete(symbolRegistry);
}

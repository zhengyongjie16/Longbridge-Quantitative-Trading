/**
 * 交易日志冷却恢复模块
 *
 * 功能：
 * - 启动时读取当日成交日志
 * - 按监控标的方向取最后一条保护性清仓记录
 * - 写入清仓冷却缓存
 */
import type { TradeLogHydrator, TradeLogHydratorDeps, RawRecord } from './types.js';
import type { TradeRecord } from '../../core/trader/types.js';
import type { SeatSymbolSnapshotEntry } from '../../types/seat.js';
import { buildTradeLogPath } from '../../core/trader/utils.js';
import {
  toStringOrNull,
  toNumberOrNull,
  toBooleanOrNull,
  resolveCooldownCandidatesBySeat,
} from './utils.js';

/**
 * 将 JSON 解析结果规范化为 TradeRecord，对每个字段做类型安全转换；清仓冷却仅依赖结构键值，局部信任 JSON 解析结果。
 * @param raw - 单条日志解析后的未知类型
 * @returns 规范化后的 TradeRecord，无效时 null
 */
function normalizeTradeRecord(raw: unknown): TradeRecord | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  // 清仓冷却仅依赖 TradeRecord 的键值，这里在局部信任 JSON 解析结果结构并做结构性断言
  const obj = raw as RawRecord;
  const record: TradeRecord = {
    orderId: toStringOrNull(obj['orderId']),
    symbol: toStringOrNull(obj['symbol']),
    symbolName: toStringOrNull(obj['symbolName']),
    monitorSymbol: toStringOrNull(obj['monitorSymbol']),
    action: toStringOrNull(obj['action']),
    side: toStringOrNull(obj['side']),
    quantity: toStringOrNull(obj['quantity']),
    price: toStringOrNull(obj['price']),
    orderType: toStringOrNull(obj['orderType']),
    status: toStringOrNull(obj['status']),
    error: toStringOrNull(obj['error']),
    reason: toStringOrNull(obj['reason']),
    signalTriggerTime: toStringOrNull(obj['signalTriggerTime']),
    executedAt: toStringOrNull(obj['executedAt']),
    executedAtMs: toNumberOrNull(obj['executedAtMs']),
    timestamp: toStringOrNull(obj['timestamp']),
    isProtectiveClearance: toBooleanOrNull(obj['isProtectiveClearance']),
  };

  return record;
}

/**
 * 创建交易日志冷却恢复器，绑定文件读取、冷却追踪器等依赖，对外暴露 hydrate 方法。
 * @param deps - 依赖（tradeLogPath、liquidationCooldownTracker、getSeatSymbolSnapshot 等）
 * @returns TradeLogHydrator 实例（hydrate 方法用于启动时恢复冷却状态）
 */
export function createTradeLogHydrator(deps: TradeLogHydratorDeps): TradeLogHydrator {
  const {
    readFileSync,
    existsSync,
    cwd,
    nowMs,
    logger,
    tradingConfig,
    liquidationCooldownTracker,
  } = deps;

  const monitorConfigMap = new Map(
    tradingConfig.monitors.map((config) => [config.monitorSymbol, config]),
  );

  /**
   * 读取当日成交日志，按席位方向筛选最后一条保护性清仓记录并写入冷却缓存。
   * 启动时调用一次，用于跨进程重启后恢复未到期的清仓冷却状态。
   */
  function hydrate({
    seatSymbols,
  }: {
    readonly seatSymbols: ReadonlyArray<SeatSymbolSnapshotEntry>;
  }): void {
    const logFile = buildTradeLogPath(cwd(), new Date(nowMs()));
    if (!existsSync(logFile)) {
      logger.info(`[清仓冷却] 当日成交日志不存在，跳过冷却恢复: ${logFile}`);
      return;
    }

    let parsed: unknown;
    try {
      const content = readFileSync(logFile, 'utf-8');
      parsed = JSON.parse(content);
    } catch (err) {
      logger.error('[清仓冷却] 成交日志解析失败，跳过冷却恢复', err);
      return;
    }

    if (!Array.isArray(parsed)) {
      logger.warn('[清仓冷却] 成交日志格式无效，跳过冷却恢复');
      return;
    }

    const records: TradeRecord[] = [];
    for (const item of parsed) {
      const normalized = normalizeTradeRecord(item);
      if (!normalized) {
        continue;
      }
      records.push(normalized);
    }

    let restoredCount = 0;
    const candidates = resolveCooldownCandidatesBySeat({
      seatSymbols,
      tradeRecords: records,
    });

    for (const candidate of candidates) {
      const monitorConfig = monitorConfigMap.get(candidate.monitorSymbol) ?? null;
      const cooldownConfig = monitorConfig?.liquidationCooldown ?? null;
      if (!cooldownConfig) {
        continue;
      }

      liquidationCooldownTracker.recordCooldown({
        symbol: candidate.monitorSymbol,
        direction: candidate.direction,
        executedTimeMs: candidate.executedAtMs,
      });

      const remainingMs = liquidationCooldownTracker.getRemainingMs({
        symbol: candidate.monitorSymbol,
        direction: candidate.direction,
        cooldownConfig,
      });

      if (remainingMs > 0) {
        restoredCount += 1;
      }
    }

    logger.info(`[清仓冷却] 启动恢复完成，恢复冷却条数=${restoredCount}`);
  }

  return {
    hydrate,
  };
}

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
 * 类型保护：判断 unknown 是否为交易日志原始记录。
 *
 * @param value 待判断值
 * @returns true 表示可按键读取字段
 */
function isRawRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null;
}

/**
 * 将 JSON 解析结果规范化为 TradeRecord，对每个字段做类型安全转换；清仓冷却仅依赖结构键值，局部信任 JSON 解析结果。
 * @param raw - 单条日志解析后的未知类型
 * @returns 规范化后的 TradeRecord，无效时 null
 */
function normalizeTradeRecord(raw: unknown): TradeRecord | null {
  if (!isRawRecord(raw)) {
    return null;
  }
  const record: TradeRecord = {
    orderId: toStringOrNull(raw['orderId']),
    symbol: toStringOrNull(raw['symbol']),
    symbolName: toStringOrNull(raw['symbolName']),
    monitorSymbol: toStringOrNull(raw['monitorSymbol']),
    action: toStringOrNull(raw['action']),
    side: toStringOrNull(raw['side']),
    quantity: toStringOrNull(raw['quantity']),
    price: toStringOrNull(raw['price']),
    orderType: toStringOrNull(raw['orderType']),
    status: toStringOrNull(raw['status']),
    error: toStringOrNull(raw['error']),
    reason: toStringOrNull(raw['reason']),
    signalTriggerTime: toStringOrNull(raw['signalTriggerTime']),
    executedAt: toStringOrNull(raw['executedAt']),
    executedAtMs: toNumberOrNull(raw['executedAtMs']),
    timestamp: toStringOrNull(raw['timestamp']),
    isProtectiveClearance: toBooleanOrNull(raw['isProtectiveClearance']),
  };

  return record;
}

/**
 * 创建交易日志冷却恢复器，绑定文件读取、冷却追踪器等依赖，对外暴露 hydrate 方法。
 * @param deps - 依赖（日志目录解析、liquidationCooldownTracker、getSeatSymbolSnapshot 等）
 * @returns TradeLogHydrator 实例（hydrate 方法用于启动时恢复冷却状态）
 */
export function createTradeLogHydrator(deps: TradeLogHydratorDeps): TradeLogHydrator {
  const {
    readFileSync,
    existsSync,
    resolveLogRootDir,
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
    const logFile = buildTradeLogPath(resolveLogRootDir(), new Date(nowMs()));
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

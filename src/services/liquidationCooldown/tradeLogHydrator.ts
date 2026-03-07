/**
 * 交易日志冷却恢复模块
 *
 * 功能：
 * - 启动时读取当日成交日志
 * - 按监控标的方向收集保护性清仓记录并模拟触发周期
 * - 恢复触发计数器与仍有效的清仓冷却缓存
 */
import type { TradeLogHydrator, TradeLogHydratorDeps, RawRecord, HydrateResult } from './types.js';
import type { TradeRecord } from '../../core/trader/types.js';
import { isRecord } from '../../utils/primitives/index.js';
import { buildTradeLogPath } from '../../core/trader/utils.js';
import {
  collectLiquidationRecordsByMonitor,
  resolveCooldownEndMs,
  simulateTriggerCycle,
  toStringOrNull,
  toNumberOrNull,
  toBooleanOrNull,
} from './utils.js';

/**
 * 将 JSON 解析结果规范化为 TradeRecord，对每个字段做类型安全转换；清仓冷却仅依赖结构键值，局部信任 JSON 解析结果。
 * @param raw - 单条日志解析后的未知类型
 * @returns 规范化后的 TradeRecord，无效时 null
 */
function normalizeTradeRecord(raw: unknown): TradeRecord | null {
  if (!isRecord(raw)) {
    return null;
  }

  const rawRecord: RawRecord = raw;
  const record: TradeRecord = {
    orderId: toStringOrNull(rawRecord['orderId']),
    symbol: toStringOrNull(rawRecord['symbol']),
    symbolName: toStringOrNull(rawRecord['symbolName']),
    monitorSymbol: toStringOrNull(rawRecord['monitorSymbol']),
    action: toStringOrNull(rawRecord['action']),
    side: toStringOrNull(rawRecord['side']),
    quantity: toStringOrNull(rawRecord['quantity']),
    price: toStringOrNull(rawRecord['price']),
    orderType: toStringOrNull(rawRecord['orderType']),
    status: toStringOrNull(rawRecord['status']),
    error: toStringOrNull(rawRecord['error']),
    reason: toStringOrNull(rawRecord['reason']),
    signalTriggerTime: toStringOrNull(rawRecord['signalTriggerTime']),
    executedAt: toStringOrNull(rawRecord['executedAt']),
    executedAtMs: toNumberOrNull(rawRecord['executedAtMs']),
    timestamp: toStringOrNull(rawRecord['timestamp']),
    isProtectiveClearance: toBooleanOrNull(rawRecord['isProtectiveClearance']),
  };

  return record;
}

/**
 * 将分段起始时间写入 map，若已存在则保留更晚（更靠近当前）的分段边界。
 *
 * @param map 分段边界 map（key 为 monitorSymbol:direction）
 * @param key 方向键
 * @param segmentStartMs 候选分段起始时间
 */
function setLatestSegmentStart(
  map: Map<string, number>,
  key: string,
  segmentStartMs: number,
): void {
  const existing = map.get(key);
  if (existing === undefined || segmentStartMs > existing) {
    map.set(key, segmentStartMs);
  }
}

/**
 * 创建交易日志冷却恢复器，绑定文件读取、冷却追踪器等依赖，对外暴露 hydrate 方法。
 * @param deps - 依赖（日志目录解析、liquidationCooldownTracker 等）
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

  const EMPTY_RESULT: HydrateResult = { segmentStartByDirection: new Map() };

  /**
   * 读取当日成交日志，按监控标的方向模拟触发-冷却周期并恢复当前状态。
   * 启动时调用一次，用于跨进程重启后恢复触发计数器和未到期冷却。
   * 返回的 segmentStartByDirection 会作为“日内亏损分段起点”，供 dailyLossTracker 在回算偏移时截断旧段成交：
   * - 冷却仍有效：保持当前周期不切段，后续成交继续累加到同一分段
   * - 冷却已过期：以 cooldownEndMs 作为新分段起点，冷却前的成交不再计入当前偏移
   */
  function hydrate(): HydrateResult {
    const logFile = buildTradeLogPath(resolveLogRootDir(), new Date(nowMs()));
    if (!existsSync(logFile)) {
      logger.debug(`[清仓冷却] 当日成交日志不存在，跳过冷却恢复: ${logFile}`);
      return EMPTY_RESULT;
    }

    let parsed: unknown;
    try {
      const content = readFileSync(logFile, 'utf8');
      parsed = JSON.parse(content);
    } catch (err) {
      logger.error('[清仓冷却] 成交日志解析失败，跳过冷却恢复', err);
      return EMPTY_RESULT;
    }

    if (!Array.isArray(parsed)) {
      logger.warn('[清仓冷却] 成交日志格式无效，跳过冷却恢复');
      return EMPTY_RESULT;
    }

    const records: TradeRecord[] = [];
    for (const item of parsed) {
      const normalized = normalizeTradeRecord(item);
      if (!normalized) {
        continue;
      }

      records.push(normalized);
    }

    let restoredCooldownCount = 0;
    const segmentStartByDirection = new Map<string, number>();
    const monitorSymbols = new Set(tradingConfig.monitors.map((config) => config.monitorSymbol));
    const groupedRecords = collectLiquidationRecordsByMonitor({
      monitorSymbols,
      tradeRecords: records,
    });

    for (const recordGroup of groupedRecords.values()) {
      const firstRecord = recordGroup[0];
      if (!firstRecord) {
        continue;
      }

      const directionKey = `${firstRecord.monitorSymbol}:${firstRecord.direction}`;
      const monitorConfig = monitorConfigMap.get(firstRecord.monitorSymbol) ?? null;
      const cooldownConfig = monitorConfig?.liquidationCooldown ?? null;
      if (!cooldownConfig) {
        continue;
      }

      const triggerLimit = monitorConfig?.liquidationTriggerLimit ?? 1;
      const cycleResult = simulateTriggerCycle({
        records: recordGroup,
        triggerLimit,
        cooldownConfig,
      });

      if (
        cycleResult.lastExpiredCooldownEndMs !== null &&
        Number.isFinite(cycleResult.lastExpiredCooldownEndMs)
      ) {
        setLatestSegmentStart(
          segmentStartByDirection,
          directionKey,
          cycleResult.lastExpiredCooldownEndMs,
        );
      }

      if (cycleResult.currentCount > 0) {
        liquidationCooldownTracker.restoreTriggerCount({
          symbol: firstRecord.monitorSymbol,
          direction: firstRecord.direction,
          count: cycleResult.currentCount,
        });
      }

      if (cycleResult.cooldownExecutedTimeMs === null) {
        continue;
      }

      liquidationCooldownTracker.recordCooldown({
        symbol: firstRecord.monitorSymbol,
        direction: firstRecord.direction,
        executedTimeMs: cycleResult.cooldownExecutedTimeMs,
      });

      const remainingMs = liquidationCooldownTracker.getRemainingMs({
        symbol: firstRecord.monitorSymbol,
        direction: firstRecord.direction,
        cooldownConfig,
      });

      // 计算分段边界：冷却活跃时无需切段（当前冷却内的成交仍属同一分段）；
      // 冷却已过期时，cooldownEndMs 作为新分段起始时间，旧段成交不纳入偏移
      const cooldownEndMs = resolveCooldownEndMs(
        cycleResult.cooldownExecutedTimeMs,
        cooldownConfig,
      );
      if (remainingMs > 0) {
        restoredCooldownCount += 1;
        logger.debug(
          `[清仓冷却] 恢复 ${firstRecord.monitorSymbol}:${firstRecord.direction} 冷却，` +
            `当前周期触发 ${cycleResult.currentCount}/${triggerLimit}，` +
            `剩余 ${Math.ceil(remainingMs / 1000)} 秒`,
        );
      } else if (cooldownEndMs !== null && Number.isFinite(cooldownEndMs)) {
        // 冷却已过期：设置分段起始时间为冷却结束时间
        setLatestSegmentStart(segmentStartByDirection, directionKey, cooldownEndMs);
        logger.debug(
          `[清仓冷却] ${firstRecord.monitorSymbol}:${firstRecord.direction} 历史冷却已过期，` +
            `分段起始时间=${cooldownEndMs}`,
        );
      }
    }

    logger.info(`[清仓冷却] 启动恢复完成，恢复冷却条数=${restoredCooldownCount}`);
    return { segmentStartByDirection };
  }

  return {
    hydrate,
  };
}

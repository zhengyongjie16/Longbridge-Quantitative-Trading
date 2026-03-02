/**
 * 交易日志冷却恢复模块
 *
 * 功能：
 * - 启动时读取当日成交日志
 * - 按监控标的方向收集保护性清仓记录并模拟触发周期
 * - 恢复触发计数器与仍有效的清仓冷却缓存
 */
import type { TradeLogHydrator, TradeLogHydratorDeps, RawRecord } from './types.js';
import type { TradeRecord } from '../../core/trader/types.js';
import { isRecord } from '../../utils/primitives/index.js';
import { buildTradeLogPath } from '../../core/trader/utils.js';
import {
  collectLiquidationRecordsByMonitor,
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

  /**
   * 读取当日成交日志，按监控标的方向模拟触发-冷却周期并恢复当前状态。
   * 启动时调用一次，用于跨进程重启后恢复触发计数器和未到期冷却。
   */
  function hydrate(): void {
    const logFile = buildTradeLogPath(resolveLogRootDir(), new Date(nowMs()));
    if (!existsSync(logFile)) {
      logger.info(`[清仓冷却] 当日成交日志不存在，跳过冷却恢复: ${logFile}`);
      return;
    }

    let parsed: unknown;
    try {
      const content = readFileSync(logFile, 'utf8');
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

    let restoredCooldownCount = 0;
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

      if (remainingMs > 0) {
        restoredCooldownCount += 1;
        logger.info(
          `[清仓冷却] 恢复 ${firstRecord.monitorSymbol}:${firstRecord.direction} 冷却，` +
            `当前周期触发 ${cycleResult.currentCount}/${triggerLimit}，` +
            `剩余 ${Math.ceil(remainingMs / 1000)} 秒`,
        );
      }
    }

    logger.info(`[清仓冷却] 启动恢复完成，恢复冷却条数=${restoredCooldownCount}`);
  }

  return {
    hydrate,
  };
}

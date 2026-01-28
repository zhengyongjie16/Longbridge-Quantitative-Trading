/**
 * 交易日志冷却恢复模块
 *
 * 功能：
 * - 启动时读取当日成交日志
 * - 按监控标的方向取最后一条保护性清仓记录
 * - 写入清仓冷却缓存
 */

import type { TradeLogHydrator, TradeLogHydratorDeps, NormalizedTradeRecord } from './types.js';
import type { TradeRecord } from '../../core/trader/types.js';
import { buildTradeLogPath } from '../../core/trader/utils.js';
import {
  resolveDirectionFromAction,
  toStringOrNull,
  toNumberOrNull,
  toBooleanOrNull,
} from './utils.js';

type RawRecord = Record<string, unknown>;

const normalizeTradeRecord = (raw: unknown): NormalizedTradeRecord | null => {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
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

  const direction = resolveDirectionFromAction(record.action);
  if (!direction) {
    return null;
  }
  return { record, direction };
};

export const createTradeLogHydrator = (deps: TradeLogHydratorDeps): TradeLogHydrator => {
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

  const hydrate = (): void => {
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

    const lastByKey = new Map<string, NormalizedTradeRecord>();

    for (const item of parsed) {
      const normalized = normalizeTradeRecord(item);
      if (!normalized) {
        continue;
      }

      const { record, direction } = normalized;
      if (record.isProtectiveClearance !== true) {
        continue;
      }
      if (!record.monitorSymbol || record.executedAtMs == null) {
        continue;
      }
      if (!monitorConfigMap.has(record.monitorSymbol)) {
        continue;
      }

      const key = `${record.monitorSymbol}:${direction}`;
      const existing = lastByKey.get(key);
      if (!existing || record.executedAtMs > (existing.record.executedAtMs ?? 0)) {
        lastByKey.set(key, normalized);
      }
    }

    let restoredCount = 0;
    for (const entry of lastByKey.values()) {
      const record = entry.record;
      const direction = entry.direction;
      const monitorSymbol = record.monitorSymbol;
      const executedAtMs = record.executedAtMs;
      if (!monitorSymbol || executedAtMs == null) {
        continue;
      }

      const monitorConfig = monitorConfigMap.get(monitorSymbol) ?? null;
      const cooldownConfig = monitorConfig?.liquidationCooldown ?? null;
      if (!cooldownConfig) {
        continue;
      }

      liquidationCooldownTracker.recordCooldown({
        symbol: monitorSymbol,
        direction,
        executedTimeMs: executedAtMs,
      });

      const remainingMs = liquidationCooldownTracker.getRemainingMs({
        symbol: monitorSymbol,
        direction,
        cooldownConfig,
      });

      if (remainingMs > 0) {
        restoredCount += 1;
      }
    }

    logger.info(`[清仓冷却] 启动恢复完成，恢复冷却条数=${restoredCount}`);
  };

  return {
    hydrate,
  };
};

/**
 * 交易记录模块
 *
 * 职责：
 * - 记录交易到 JSON 文件（logs/trades/YYYY-MM-DD.json）
 * - 识别错误类型（资金不足、不支持做空、网络错误等）
 *
 * 记录内容：订单ID、标的、方向、数量、价格、状态、原因、时间戳
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../utils/logger/index.js';
import { toBeijingTimeIso } from '../../utils/helpers/index.js';
import { buildTradeLogPath } from './utils.js';
import type { TradeRecord, ErrorTypeIdentifier } from './types.js';

/** 识别错误类型（通过错误消息关键词匹配） */
export function identifyErrorType(errorMessage: string): ErrorTypeIdentifier {
  const lowerMsg = errorMessage.toLowerCase();

  return {
    isShortSellingNotSupported:
      lowerMsg.includes('does not support short selling') ||
      lowerMsg.includes('不支持做空') ||
      lowerMsg.includes('short selling') ||
      lowerMsg.includes('做空'),
    isInsufficientFunds:
      lowerMsg.includes('insufficient') ||
      lowerMsg.includes('资金不足') ||
      lowerMsg.includes('余额不足'),
    isOrderNotFound:
      lowerMsg.includes('not found') ||
      lowerMsg.includes('不存在') ||
      lowerMsg.includes('找不到'),
    isNetworkError:
      lowerMsg.includes('network') ||
      lowerMsg.includes('网络') ||
      lowerMsg.includes('timeout') ||
      lowerMsg.includes('超时'),
    isRateLimited:
      lowerMsg.includes('rate limit') ||
      lowerMsg.includes('频率') ||
      lowerMsg.includes('too many'),
  };
}

/** 记录交易到 JSON 文件（按日期分文件存储） */
export function recordTrade(tradeRecord: TradeRecord): void {
  try {
    const logDir = path.join(process.cwd(), 'logs', 'trades');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logFile = buildTradeLogPath(process.cwd(), new Date());

    let trades: TradeRecord[] = [];
    if (fs.existsSync(logFile)) {
      const content = fs.readFileSync(logFile, 'utf-8');
      try {
        trades = JSON.parse(content) as TradeRecord[];
        // 确保解析结果是数组
        if (!Array.isArray(trades)) {
          logger.warn(`交易记录文件格式错误，重置为空数组: ${logFile}`);
          trades = [];
        }
      } catch (e) {
        logger.warn(
          `解析交易记录文件失败，重置为空数组: ${logFile}`,
          (e as Error)?.message ?? e,
        );
        trades = [];
      }
    }

    const executedAtMs = Number.isFinite(tradeRecord.executedAtMs ?? Number.NaN)
      ? tradeRecord.executedAtMs
      : null;
    const signalTriggerTime = tradeRecord.signalTriggerTime ?? null;
    const executedAt = tradeRecord.executedAt ?? null;

    // 构建记录对象（缺失字段写入 null）
    const record: TradeRecord = {
      orderId: tradeRecord.orderId ?? null,
      symbol: tradeRecord.symbol ?? null,
      symbolName: tradeRecord.symbolName ?? null,
      monitorSymbol: tradeRecord.monitorSymbol ?? null,
      action: tradeRecord.action ?? null,
      side: tradeRecord.side ?? null,
      quantity: tradeRecord.quantity ?? null,
      price: tradeRecord.price ?? null,
      orderType: tradeRecord.orderType ?? null,
      status: tradeRecord.status ?? null,
      error: tradeRecord.error ?? null,
      reason: tradeRecord.reason ?? null,
      signalTriggerTime,
      executedAt,
      executedAtMs,
      timestamp: toBeijingTimeIso(),
      isProtectiveClearance: tradeRecord.isProtectiveClearance ?? null,
    };

    trades.push(record);

    fs.writeFileSync(logFile, JSON.stringify(trades, null, 2), 'utf-8');
  } catch (err) {
    logger.error('写入交易记录失败', err);
  }
}

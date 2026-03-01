/**
 * 交易记录模块
 *
 * 职责：
 * - 记录交易到 JSON 文件（<logRootDir>/trades/YYYY-MM-DD.json）
 * - 识别错误类型（资金不足、不支持做空、网络错误等）
 *
 * 记录内容：订单ID、标的、方向、数量、价格、状态、原因、时间戳
 */
import fs from 'node:fs';
import path from 'node:path';
import { LOGGING } from '../../constants/index.js';
import { logger, retainLatestLogFiles } from '../../utils/logger/index.js';
import { resolveLogRootDir } from '../../utils/runtime/index.js';
import { toHongKongTimeIso } from '../../utils/time/index.js';
import { isRecord } from '../../utils/primitives/index.js';
import { buildTradeLogPath } from './utils.js';
import type { TradeRecord, ErrorTypeIdentifier } from './types.js';

/**
 * 类型守卫：校验 unknown 是否为符合 TradeRecord 结构的对象。
 *
 * @param record 待校验值
 * @returns 为 true 时收窄为 TradeRecord
 */
function isValidTradeRecord(record: unknown): record is TradeRecord {
  if (!isRecord(record)) {
    return false;
  }

  // 校验必需字段的类型（允许 null）
  return (
    (record['orderId'] === null || typeof record['orderId'] === 'string') &&
    (record['symbol'] === null || typeof record['symbol'] === 'string') &&
    (record['symbolName'] === null || typeof record['symbolName'] === 'string') &&
    (record['monitorSymbol'] === null || typeof record['monitorSymbol'] === 'string') &&
    (record['action'] === null || typeof record['action'] === 'string') &&
    (record['side'] === null || typeof record['side'] === 'string') &&
    (record['quantity'] === null || typeof record['quantity'] === 'string') &&
    (record['price'] === null || typeof record['price'] === 'string') &&
    (record['orderType'] === null || typeof record['orderType'] === 'string') &&
    (record['status'] === null || typeof record['status'] === 'string') &&
    (record['error'] === null || typeof record['error'] === 'string') &&
    (record['reason'] === null || typeof record['reason'] === 'string') &&
    (record['signalTriggerTime'] === null || typeof record['signalTriggerTime'] === 'string') &&
    (record['executedAt'] === null || typeof record['executedAt'] === 'string') &&
    (record['executedAtMs'] === null || typeof record['executedAtMs'] === 'number') &&
    (record['timestamp'] === null || typeof record['timestamp'] === 'string') &&
    (record['isProtectiveClearance'] === null ||
      typeof record['isProtectiveClearance'] === 'boolean')
  );
}

/**
 * 类型守卫：校验 unknown 是否为 TradeRecord 数组（每项通过 isValidTradeRecord）。
 *
 * @param records 待校验值
 * @returns 为 true 时收窄为 TradeRecord[]
 */
function isValidTradeRecordArray(records: unknown): records is TradeRecord[] {
  return Array.isArray(records) && records.every(isValidTradeRecord);
}

/**
 * 识别错误类型（通过错误消息关键词匹配）
 * 用于区分资金不足、不支持做空、订单不存在、网络错误、限流等，便于日志与风控处理。
 * @param errorMessage 错误消息原文（将转为小写后匹配关键词）
 * @returns 错误类型标识对象，各布尔字段表示是否匹配对应类型
 */
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
      lowerMsg.includes('not found') || lowerMsg.includes('不存在') || lowerMsg.includes('找不到'),
    isNetworkError:
      lowerMsg.includes('network') ||
      lowerMsg.includes('网络') ||
      lowerMsg.includes('timeout') ||
      lowerMsg.includes('超时'),
    isRateLimited:
      lowerMsg.includes('rate limit') || lowerMsg.includes('频率') || lowerMsg.includes('too many'),
  };
}

/**
 * 记录交易到 JSON 文件（按日期分文件存储）
 * 写入 <logRootDir>/trades/YYYY-MM-DD.json，缺失字段补 null，并执行日志文件保留策略。
 * @param tradeRecord 单笔交易记录，字段可为 null
 * @returns 无返回值；写入失败时仅记录错误日志
 */
export function recordTrade(tradeRecord: TradeRecord): void {
  try {
    const logRootDir = resolveLogRootDir(process.env);
    const logDir = path.join(logRootDir, 'trades');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logFile = buildTradeLogPath(logRootDir, new Date());
    retainLatestLogFiles(logDir, LOGGING.MAX_RETAINED_LOG_FILES, 'json', path.basename(logFile));
    let trades: TradeRecord[] = [];
    if (fs.existsSync(logFile)) {
      const content = fs.readFileSync(logFile, 'utf8');
      try {
        const parsed: unknown = JSON.parse(content);

        // 信任边界：校验 JSON 解析结果
        if (isValidTradeRecordArray(parsed)) {
          trades = parsed;
        } else {
          logger.warn(`交易记录文件格式错误，重置为空数组: ${logFile}`);
          trades = [];
        }
      } catch (e) {
        const parseErrorMessage = e instanceof Error ? e.message : String(e);
        logger.warn(`解析交易记录文件失败，重置为空数组: ${logFile}`, parseErrorMessage);
        trades = [];
      }
    }
    const executedAtMs = Number.isFinite(tradeRecord.executedAtMs)
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
      timestamp: toHongKongTimeIso(),
      isProtectiveClearance: tradeRecord.isProtectiveClearance ?? null,
    };
    trades.push(record);
    fs.writeFileSync(logFile, JSON.stringify(trades, null, 2), 'utf8');
  } catch (err) {
    logger.error('写入交易记录失败', err);
  }
}

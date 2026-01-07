/**
 * 交易记录模块
 *
 * 功能：
 * - 记录交易到文件
 * - 识别错误类型
 */

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../utils/logger/index.js';
import { toBeijingTimeIso, formatSymbolDisplay } from '../../utils/helpers/index.js';
import type { TradeRecord, ErrorTypeIdentifier } from './type.js';

/**
 * 错误类型识别辅助函数
 * @param errorMessage - 错误消息字符串
 * @returns 错误类型标识对象
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

/**
 * 记录交易到文件
 * @param tradeRecord 交易记录对象
 */
export function recordTrade(tradeRecord: TradeRecord): void {
  try {
    const logDir = path.join(process.cwd(), 'logs', 'trades');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    const today = new Date().toISOString().split('T')[0];
    const logFile = path.join(logDir, `${today}.json`);

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

    // 格式化标的显示
    const symbolDisplay = formatSymbolDisplay(
      tradeRecord.symbol,
      tradeRecord.symbolName ?? undefined,
    );

    // 处理信号触发时间
    let signalTriggerTime: string | null = null;
    if (tradeRecord.signalTriggerTime) {
      if (tradeRecord.signalTriggerTime instanceof Date) {
        signalTriggerTime = toBeijingTimeIso(tradeRecord.signalTriggerTime);
      } else if (typeof tradeRecord.signalTriggerTime === 'string') {
        // 如果是字符串，尝试解析为Date
        const parsedDate = new Date(tradeRecord.signalTriggerTime);
        if (!Number.isNaN(parsedDate.getTime())) {
          signalTriggerTime = toBeijingTimeIso(parsedDate);
        }
      }
    }

    // 构建记录对象（不可变方式）
    // 先创建包含所有字段的对象，然后使用解构移除 symbolName
    const { symbolName: _unused, ...recordWithoutSymbolName } = {
      ...tradeRecord,
      symbol: symbolDisplay, // 使用格式化后的标的显示
      timestamp: toBeijingTimeIso(), // 记录时间使用北京时间
      ...(signalTriggerTime && { signalTriggerTime }), // 条件性添加 signalTriggerTime
    };

    const record: TradeRecord = recordWithoutSymbolName;

    trades.push(record);

    fs.writeFileSync(logFile, JSON.stringify(trades, null, 2), 'utf-8');
  } catch (err) {
    logger.error('写入交易记录失败', err);
  }
}

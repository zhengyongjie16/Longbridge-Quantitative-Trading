/**
 * 末日保护模块
 *
 * 功能：
 * - 收盘前的风险控制
 * - 收盘前 15 分钟拒绝买入新订单
 * - 收盘前 5 分钟自动清仓所有持仓
 *
 * 时间规则：
 * - 正常交易日：15:45-16:00 拒绝买入，15:55-15:59 自动清仓
 * - 半日交易日：11:45-12:00 拒绝买入，11:55-11:59 自动清仓
 *
 * 控制开关：
 * - DOOMSDAY_PROTECTION 环境变量（默认 true）
 */

import { logger } from '../../utils/logger/index.js';
import { normalizeHKSymbol } from '../../utils/helpers/index.js';
import { isBeforeClose15Minutes, isBeforeClose5Minutes } from '../../utils/tradingTime/index.js';
import { signalObjectPool } from '../../utils/objectPool/index.js';
import type { Position, Quote, Signal } from '../../types/index.js';
import type { DoomsdayProtection } from './types.js';

/**
 * 创建末日保护程序
 * 在收盘前执行保护性操作：
 * - 收盘前15分钟拒绝买入
 * - 收盘前5分钟自动清仓
 */
export const createDoomsdayProtection = (): DoomsdayProtection => {
  return {
    shouldRejectBuy: (currentTime: Date, isHalfDay: boolean): boolean => {
      return isBeforeClose15Minutes(currentTime, isHalfDay);
    },

    shouldClearPositions: (currentTime: Date, isHalfDay: boolean): boolean => {
      return isBeforeClose5Minutes(currentTime, isHalfDay);
    },

    generateClearanceSignals: (
      positions: ReadonlyArray<Position>,
      longQuote: Quote | null,
      shortQuote: Quote | null,
      longSymbol: string,
      shortSymbol: string,
      isHalfDay: boolean,
    ): ReadonlyArray<Signal> => {
      const clearSignals: Signal[] = [];
      const normalizedLongSymbol = normalizeHKSymbol(longSymbol);
      const normalizedShortSymbol = normalizeHKSymbol(shortSymbol);

      const closeTimeRange = isHalfDay ? '11:55-11:59' : '15:55-15:59';
      logger.info(
        `[末日保护程序] 收盘前5分钟（${closeTimeRange}），准备清空所有持仓`,
      );

      // 验证 positions 是数组
      if (!Array.isArray(positions) || positions.length === 0) {
        return clearSignals;
      }

      for (const pos of positions) {
        // 验证持仓对象有效性
        if (!pos?.symbol || typeof pos.symbol !== 'string') {
          continue; // 跳过无效持仓
        }

        const availableQty = Number(pos.availableQuantity) || 0;
        if (!Number.isFinite(availableQty) || availableQty <= 0) {
          continue; // 跳过无效或零持仓
        }

        const normalizedPosSymbol = normalizeHKSymbol(pos.symbol);
        const isShortPos = normalizedPosSymbol === normalizedShortSymbol;

        // 获取该标的的当前价格、最小买卖单位和名称
        let currentPrice: number | null = null;
        let lotSize: number | null = null;
        let symbolName: string | null = pos.symbolName || null; // 优先使用持仓中的名称
        if (normalizedPosSymbol === normalizedLongSymbol && longQuote) {
          currentPrice = longQuote.price;
          lotSize = longQuote.lotSize ?? null;
          if (!symbolName) {
            symbolName = longQuote.name;
          }
        } else if (
          normalizedPosSymbol === normalizedShortSymbol &&
          shortQuote
        ) {
          currentPrice = shortQuote.price;
          lotSize = shortQuote.lotSize ?? null;
          if (!symbolName) {
            symbolName = shortQuote.name;
          }
        }

        // 收盘前清仓逻辑：
        // - 做多标的持仓：使用 SELLCALL 信号 → OrderSide.Sell（卖出做多标的，清仓）
        // - 做空标的持仓：使用 SELLPUT 信号 → OrderSide.Sell（卖出做空标的，平空仓）
        const action = isShortPos ? 'SELLPUT' : 'SELLCALL';
        const positionType = isShortPos ? '做空标的' : '做多标的';

        // 从对象池获取信号对象
        const signal = signalObjectPool.acquire() as Signal;
        signal.symbol = normalizedPosSymbol;
        signal.symbolName = symbolName;
        signal.action = action;
        signal.price = currentPrice;
        signal.lotSize = lotSize;
        signal.reason = `末日保护程序：收盘前5分钟自动清仓（${positionType}持仓）`;
        signal.signalTriggerTime = new Date();

        clearSignals.push(signal);

        logger.info(
          `[末日保护程序] 生成清仓信号：${positionType} ${pos.symbol} 数量=${availableQty} 操作=${action}`,
        );
      }

      if (clearSignals.length > 0) {
        logger.info(
          `[末日保护程序] 共生成 ${clearSignals.length} 个清仓信号，准备执行`,
        );
      }

      return clearSignals;
    },
  };
};

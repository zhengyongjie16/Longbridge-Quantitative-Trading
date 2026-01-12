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
import { batchGetQuotes } from '../../utils/helpers/quoteHelpers.js';
import { isBeforeClose15Minutes, isBeforeClose5Minutes } from '../../utils/helpers/tradingTime.js';
import type { Position, Quote, Signal, SignalType } from '../../types/index.js';
import type { DoomsdayProtection, DoomsdayClearanceContext, DoomsdayClearanceResult } from './types.js';

/**
 * 清仓信号创建参数
 */
type ClearanceSignalParams = {
  readonly normalizedSymbol: string;
  readonly symbolName: string | null;
  readonly action: SignalType;
  readonly price: number | null;
  readonly lotSize: number | null;
  readonly positionType: string;
};

/**
 * 创建单个清仓信号
 * @param params 信号参数
 * @returns Signal 对象，如果创建失败则返回 null
 */
const createClearanceSignal = (params: ClearanceSignalParams): Signal | null => {
  const { normalizedSymbol, symbolName, action, price, lotSize, positionType } = params;

  // 直接构建 Signal 对象，避免对象池类型转换问题
  const signal: Signal = {
    symbol: normalizedSymbol,
    symbolName: symbolName,
    action: action,
    reason: `末日保护程序：收盘前5分钟自动清仓（${positionType}持仓）`,
    price: price,
    lotSize: lotSize,
    signalTriggerTime: new Date(),
  };

  return signal;
};

/**
 * 处理单个持仓生成清仓信号的核心逻辑
 * @param pos 持仓
 * @param normalizedLongSymbol 规范化的做多标的代码
 * @param normalizedShortSymbol 规范化的做空标的代码
 * @param longQuote 做多标的行情
 * @param shortQuote 做空标的行情
 * @returns 清仓信号，如果该持仓不需要清仓则返回 null
 */
const processPositionForClearance = (
  pos: Position,
  normalizedLongSymbol: string,
  normalizedShortSymbol: string,
  longQuote: Quote | null,
  shortQuote: Quote | null,
): Signal | null => {
  // 验证持仓对象有效性
  if (!pos?.symbol || typeof pos.symbol !== 'string') {
    return null;
  }

  const availableQty = Number(pos.availableQuantity) || 0;
  if (!Number.isFinite(availableQty) || availableQty <= 0) {
    return null;
  }

  const normalizedPosSymbol = normalizeHKSymbol(pos.symbol);

  // 只处理属于当前监控配置的持仓
  if (normalizedPosSymbol !== normalizedLongSymbol && normalizedPosSymbol !== normalizedShortSymbol) {
    return null;
  }

  const isShortPos = normalizedPosSymbol === normalizedShortSymbol;

  // 获取该标的的当前价格、最小买卖单位和名称
  let currentPrice: number | null = null;
  let lotSize: number | null = null;
  let symbolName: string | null = pos.symbolName || null;

  if (normalizedPosSymbol === normalizedLongSymbol && longQuote) {
    currentPrice = longQuote.price;
    lotSize = longQuote.lotSize ?? null;
    if (!symbolName) {
      symbolName = longQuote.name;
    }
  } else if (normalizedPosSymbol === normalizedShortSymbol && shortQuote) {
    currentPrice = shortQuote.price;
    lotSize = shortQuote.lotSize ?? null;
    if (!symbolName) {
      symbolName = shortQuote.name;
    }
  }

  // 收盘前清仓逻辑：
  // - 做多标的持仓：使用 SELLCALL 信号 → OrderSide.Sell（卖出做多标的，清仓）
  // - 做空标的持仓：使用 SELLPUT 信号 → OrderSide.Sell（卖出做空标的，平空仓）
  const action: SignalType = isShortPos ? 'SELLPUT' : 'SELLCALL';
  const positionType = isShortPos ? '做空标的' : '做多标的';

  const signal = createClearanceSignal({
    normalizedSymbol: normalizedPosSymbol,
    symbolName,
    action,
    price: currentPrice,
    lotSize,
    positionType,
  });

  if (signal) {
    logger.info(
      `[末日保护程序] 生成清仓信号：${positionType} ${pos.symbol} 数量=${availableQty} 操作=${action}`,
    );
  }

  return signal;
};

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
        const signal = processPositionForClearance(
          pos,
          normalizedLongSymbol,
          normalizedShortSymbol,
          longQuote,
          shortQuote,
        );

        if (signal) {
          clearSignals.push(signal);
        }
      }

      if (clearSignals.length > 0) {
        logger.info(
          `[末日保护程序] 共生成 ${clearSignals.length} 个清仓信号，准备执行`,
        );
      }

      return clearSignals;
    },

    executeClearance: async (
      context: DoomsdayClearanceContext,
    ): Promise<DoomsdayClearanceResult> => {
      const {
        currentTime,
        isHalfDay,
        positions,
        monitorConfigs,
        monitorContexts,
        trader,
        marketDataClient,
        lastState,
        displayAccountAndPositions,
      } = context;

      // 检查是否应该清仓
      if (!isBeforeClose5Minutes(currentTime, isHalfDay)) {
        return { executed: false, signalCount: 0 };
      }

      // 检查是否有持仓
      if (!Array.isArray(positions) || positions.length === 0) {
        return { executed: false, signalCount: 0 };
      }

      // 收集所有唯一的交易标的
      const allTradingSymbols = new Set<string>();
      for (const monitorConfig of monitorConfigs) {
        if (monitorConfig.longSymbol) {
          allTradingSymbols.add(monitorConfig.longSymbol);
        }
        if (monitorConfig.shortSymbol) {
          allTradingSymbols.add(monitorConfig.shortSymbol);
        }
      }

      // 获取所有交易标的的行情
      const quoteMap = await batchGetQuotes(marketDataClient, allTradingSymbols);

      // 为每个监控标的生成清仓信号，然后合并去重
      const allClearanceSignals: Signal[] = [];
      for (const monitorConfig of monitorConfigs) {
        const longQuote = quoteMap.get(monitorConfig.longSymbol) ?? null;
        const shortQuote = quoteMap.get(monitorConfig.shortSymbol) ?? null;
        const normalizedLongSymbol = normalizeHKSymbol(monitorConfig.longSymbol);
        const normalizedShortSymbol = normalizeHKSymbol(monitorConfig.shortSymbol);

        // 复用 processPositionForClearance 处理每个持仓
        for (const pos of positions) {
          const signal = processPositionForClearance(
            pos,
            normalizedLongSymbol,
            normalizedShortSymbol,
            longQuote,
            shortQuote,
          );

          if (signal) {
            allClearanceSignals.push(signal);
          }
        }
      }

      // 去重：使用 (action, symbol) 作为唯一键
      const uniqueSignalsMap = new Map<string, Signal>();
      for (const signal of allClearanceSignals) {
        const key = `${signal.action}_${signal.symbol}`;
        if (!uniqueSignalsMap.has(key)) {
          uniqueSignalsMap.set(key, signal);
        }
      }
      const uniqueClearanceSignals = Array.from(uniqueSignalsMap.values());

      if (uniqueClearanceSignals.length === 0) {
        return { executed: false, signalCount: 0 };
      }

      logger.info(`[末日保护程序] 生成 ${uniqueClearanceSignals.length} 个清仓信号，准备执行`);

      // 执行清仓信号
      await trader.executeSignals(uniqueClearanceSignals);

      // 交易后获取并显示账户和持仓信息
      await displayAccountAndPositions(trader, marketDataClient, lastState);

      // 清空所有监控标的的订单记录
      for (const monitorContext of monitorContexts.values()) {
        const { config, orderRecorder } = monitorContext;
        if (config.longSymbol) {
          const quote = quoteMap.get(config.longSymbol) ?? null;
          orderRecorder.clearBuyOrders(config.longSymbol, true, quote);
        }
        if (config.shortSymbol) {
          const quote = quoteMap.get(config.shortSymbol) ?? null;
          orderRecorder.clearBuyOrders(config.shortSymbol, false, quote);
        }
      }

      return { executed: true, signalCount: uniqueClearanceSignals.length };
    },
  };
};

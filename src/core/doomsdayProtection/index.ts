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

import { OrderSide } from 'longport';
import { logger } from '../../utils/logger/index.js';
import { normalizeHKSymbol, formatError } from '../../utils/helpers/index.js';
import { batchGetQuotes } from '../../utils/helpers/quoteHelpers.js';
import { isBeforeClose15Minutes, isBeforeClose5Minutes } from '../../utils/helpers/tradingTime.js';
import { signalObjectPool } from '../../utils/objectPool/index.js';
import type { Position, Quote, Signal, SignalType } from '../../types/index.js';
import type { DoomsdayProtection, DoomsdayClearanceContext, DoomsdayClearanceResult, CancelPendingBuyOrdersContext, CancelPendingBuyOrdersResult } from './types.js';

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

  // 从对象池获取信号对象，减少内存分配
  const signal = signalObjectPool.acquire() as Signal;
  signal.symbol = normalizedSymbol;
  signal.symbolName = symbolName;
  signal.action = action;
  signal.reason = `末日保护程序：收盘前5分钟自动清仓（${positionType}持仓）`;
  signal.price = price;
  signal.lotSize = lotSize;
  signal.signalTriggerTime = new Date();

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
 * 获取当前日期字符串（用于状态重置判断）
 * @param date 日期对象
 * @returns YYYY-MM-DD 格式的日期字符串
 */
const getDateString = (date: Date): string => {
  return date.toISOString().slice(0, 10);
};

/**
 * 创建末日保护程序
 * 在收盘前执行保护性操作：
 * - 收盘前15分钟拒绝买入
 * - 收盘前5分钟自动清仓
 */
export const createDoomsdayProtection = (): DoomsdayProtection => {
  // 状态：记录当天是否已执行过收盘前15分钟的撤单检查
  // 格式为日期字符串（YYYY-MM-DD），用于跨天自动重置
  let cancelCheckExecutedDate: string | null = null;

  return {
    shouldRejectBuy: (currentTime: Date, isHalfDay: boolean): boolean => {
      return isBeforeClose15Minutes(currentTime, isHalfDay);
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

      // 释放执行后的清仓信号对象回对象池
      signalObjectPool.releaseAll(uniqueClearanceSignals);

      // 清空缓存（订单成交后会在主循环中刷新并显示账户和持仓信息）
      lastState.cachedAccount = null;
      lastState.cachedPositions = [];
      lastState.positionCache.update([]);

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

    cancelPendingBuyOrders: async (
      context: CancelPendingBuyOrdersContext,
    ): Promise<CancelPendingBuyOrdersResult> => {
      const {
        currentTime,
        isHalfDay,
        monitorConfigs,
        trader,
      } = context;

      // 检查是否在收盘前15分钟内
      if (!isBeforeClose15Minutes(currentTime, isHalfDay)) {
        // 不在 15 分钟范围内，重置状态（为下次进入做准备）
        // 注意：这里不重置 cancelCheckExecutedDate，因为跨天时日期字符串会自动不匹配
        return { executed: false, cancelledCount: 0 };
      }

      // 检查当天是否已执行过撤单检查
      // 逻辑：首次进入 15 分钟范围时执行一次，之后不再重复
      // 原因：末日保护期间已拒绝新买入，不会有新的买入订单产生
      //       已撤销的订单会进入 WebSocket 监控，无需重复查询
      const todayDateString = getDateString(currentTime);
      if (cancelCheckExecutedDate === todayDateString) {
        // 当天已执行过，直接返回
        return { executed: false, cancelledCount: 0 };
      }

      // 收集所有唯一的交易标的
      const allTradingSymbols = new Set<string>();
      for (const monitorConfig of monitorConfigs) {
        if (monitorConfig.longSymbol) {
          allTradingSymbols.add(normalizeHKSymbol(monitorConfig.longSymbol));
        }
        if (monitorConfig.shortSymbol) {
          allTradingSymbols.add(normalizeHKSymbol(monitorConfig.shortSymbol));
        }
      }

      if (allTradingSymbols.size === 0) {
        return { executed: false, cancelledCount: 0 };
      }

      const symbolsArray = Array.from(allTradingSymbols);

      // 首次进入收盘前 15 分钟，查询未成交订单
      // 注意：这是当天唯一一次查询，之后不再重复调用 Trade API
      const closeTimeRange = isHalfDay ? '11:45-12:00' : '15:45-16:00';
      logger.info(
        `[末日保护程序] 首次进入收盘前15分钟（${closeTimeRange}），检查未成交买入订单`,
      );

      const pendingOrders = await trader.getPendingOrders(symbolsArray, true);

      // 标记当天已执行过检查（无论是否有订单需要撤销）
      cancelCheckExecutedDate = todayDateString;

      // 过滤出买入订单
      const pendingBuyOrders = pendingOrders.filter(
        (order) => order.side === OrderSide.Buy,
      );

      if (pendingBuyOrders.length === 0) {
        logger.info('[末日保护程序] 无未成交买入订单，无需撤单');
        return { executed: false, cancelledCount: 0 };
      }

      logger.info(
        `[末日保护程序] 发现 ${pendingBuyOrders.length} 个未成交买入订单，准备撤单`,
      );

      // 撤销所有买入订单
      let cancelledCount = 0;
      for (const order of pendingBuyOrders) {
        try {
          const success = await trader.cancelOrder(order.orderId);
          if (success) {
            cancelledCount++;
            logger.info(
              `[末日保护程序] 撤销买入订单成功：${order.symbol} 订单ID=${order.orderId} 数量=${order.quantity} 价格=${order.submittedPrice.toFixed(3)}`,
            );
          }
        } catch (err) {
          logger.warn(
            `[末日保护程序] 撤销买入订单失败：${order.symbol} 订单ID=${order.orderId}`,
            formatError(err),
          );
        }
      }

      if (cancelledCount > 0) {
        logger.info(
          `[末日保护程序] 已撤销 ${cancelledCount}/${pendingBuyOrders.length} 个买入订单`,
        );
      }

      return { executed: true, cancelledCount };
    },
  };
};

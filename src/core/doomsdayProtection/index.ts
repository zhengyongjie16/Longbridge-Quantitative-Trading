/**
 * 末日保护模块
 *
 * 功能：
 * - 收盘前的风险控制
 * - 收盘前 15 分钟拒绝买入新订单并撤销未成交买入订单
 * - 收盘前 5 分钟自动清仓所有持仓
 *
 * 时间规则：
 * - 正常交易日：15:45-15:59:59 拒绝买入，15:55-15:59:59 自动清仓
 * - 半日交易日：11:45-11:59:59 拒绝买入，11:55-11:59:59 自动清仓
 *
 * 控制开关：
 * - DOOMSDAY_PROTECTION 环境变量（默认 true）
 */
import { OrderSide } from 'longport';
import { logger } from '../../utils/logger/index.js';
import { formatError } from '../../utils/helpers/index.js';
import { batchGetQuotes } from '../../utils/helpers/quoteHelpers.js';
import { getHKDateKey, isBeforeClose15Minutes, isBeforeClose5Minutes } from '../../utils/helpers/tradingTime.js';
import { signalObjectPool } from '../../utils/objectPool/index.js';
import { isSeatReady } from '../../services/autoSymbolManager/utils.js';
import type { MonitorContext, Position, Quote, Signal, SignalType } from '../../types/index.js';
import type { DoomsdayProtection, DoomsdayClearanceContext, DoomsdayClearanceResult, CancelPendingBuyOrdersContext, CancelPendingBuyOrdersResult, ClearanceSignalParams } from './types.js';

/** 创建单个清仓信号，从对象池获取 Signal 对象 */
function createClearanceSignal(params: ClearanceSignalParams): Signal | null {
  const { symbol, symbolName, action, price, lotSize, positionType } = params;
  const positionLabel = positionType === 'short' ? '做空标的' : '做多标的';

  // 从对象池获取信号对象，减少内存分配
  const signal = signalObjectPool.acquire() as Signal;
  signal.symbol = symbol;
  signal.symbolName = symbolName;
  signal.action = action;
  signal.reason = `末日保护程序：收盘前5分钟自动清仓（${positionLabel}持仓）`;
  signal.price = price;
  signal.lotSize = lotSize;
  signal.triggerTime = new Date(); // 末日保护信号的触发时间为当前时间

  return signal;
}

function resolveSeatSymbol(
  context: MonitorContext | undefined,
  monitorSymbol: string,
  direction: 'LONG' | 'SHORT',
): string | null {
  if (!context) {
    logger.warn(`[末日保护程序] 未找到监控上下文，跳过席位: ${monitorSymbol} ${direction}`);
    return null;
  }
  const seatState = context.symbolRegistry.getSeatState(monitorSymbol, direction);
  if (!isSeatReady(seatState)) {
    logger.info(`[末日保护程序] 席位未就绪，跳过: ${monitorSymbol} ${direction}`);
    return null;
  }
  return seatState.symbol;
}

function resolveMonitorSymbols(
  monitorSymbol: string,
  monitorContexts: DoomsdayClearanceContext['monitorContexts'],
): { longSymbol: string | null; shortSymbol: string | null } {
  const context = monitorContexts.get(monitorSymbol);

  return {
    longSymbol: resolveSeatSymbol(context, monitorSymbol, 'LONG'),
    shortSymbol: resolveSeatSymbol(context, monitorSymbol, 'SHORT'),
  };
}

/** 处理单个持仓，生成清仓信号（仅处理属于当前监控配置的持仓） */
function processPositionForClearance(
  pos: Position,
  longSymbol: string | null,
  shortSymbol: string | null,
  longQuote: Quote | null,
  shortQuote: Quote | null,
): Signal | null {
  // 验证持仓对象有效性
  if (!pos?.symbol || typeof pos.symbol !== 'string') {
    return null;
  }

  const availableQty = Number(pos.availableQuantity) || 0;
  if (!Number.isFinite(availableQty) || availableQty <= 0) {
    return null;
  }

  // 只处理属于当前监控配置的持仓
  if (pos.symbol !== longSymbol && pos.symbol !== shortSymbol) {
    return null;
  }

  const isShortPos = pos.symbol === shortSymbol;

  // 获取该标的的当前价格、最小买卖单位和名称
  let currentPrice: number | null = null;
  let lotSize: number | null = null;
  let symbolName: string | null = pos.symbolName || null;

  if (pos.symbol === longSymbol && longQuote) {
    currentPrice = longQuote.price;
    lotSize = longQuote.lotSize ?? null;
    if (!symbolName) {
      symbolName = longQuote.name;
    }
  } else if (pos.symbol === shortSymbol && shortQuote) {
    currentPrice = shortQuote.price;
    lotSize = shortQuote.lotSize ?? null;
    if (!symbolName) {
      symbolName = shortQuote.name;
    }
  }

  // 收盘前清仓
  const action: SignalType = isShortPos ? 'SELLPUT' : 'SELLCALL';
  const positionType = isShortPos ? 'short' : 'long';
  const positionLabel = positionType === 'short' ? '做空标的' : '做多标的';

  const signal = createClearanceSignal({
    symbol: pos.symbol,
    symbolName,
    action,
    price: currentPrice,
    lotSize,
    positionType,
  });

  if (signal) {
    logger.info(
      `[末日保护程序] 生成清仓信号：${positionLabel} ${pos.symbol} 数量=${availableQty} 操作=${action}`,
    );
  }

  return signal;
}

/** 创建末日保护程序（收盘前15分钟拒绝买入，收盘前5分钟自动清仓） */
export function createDoomsdayProtection(): DoomsdayProtection {
  // 状态：记录当天是否已执行过收盘前15分钟的撤单检查
  // 格式为日期字符串（YYYY-MM-DD），用于跨天自动重置
  let cancelCheckExecutedDate: string | null = null;
  let lastClearanceNoticeKey: string | null = null;

  const logClearanceNotice = (key: string, message: string): void => {
    if (lastClearanceNoticeKey === key) {
      return;
    }
    lastClearanceNoticeKey = key;
    logger.info(message);
  };

  return {
    shouldRejectBuy(currentTime: Date, isHalfDay: boolean): boolean {
      return isBeforeClose15Minutes(currentTime, isHalfDay);
    },

    async executeClearance(
      context: DoomsdayClearanceContext,
    ): Promise<DoomsdayClearanceResult> {
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

      const todayKey = getHKDateKey(currentTime) ?? currentTime.toISOString().slice(0, 10);

      // 检查是否应该清仓
      if (!isBeforeClose5Minutes(currentTime, isHalfDay)) {
        logClearanceNotice(
          `outside-window:${todayKey}`,
          '[末日保护程序] 清仓跳过：当前不在收盘前5分钟窗口',
        );
        return { executed: false, signalCount: 0 };
      }

      // 检查是否有持仓
      if (!Array.isArray(positions) || positions.length === 0) {
        logClearanceNotice(
          `no-positions:${todayKey}`,
          '[末日保护程序] 清仓跳过：无持仓',
        );
        return { executed: false, signalCount: 0 };
      }

      // 收集所有唯一的交易标的
      const allTradingSymbols = new Set<string>();
      for (const monitorConfig of monitorConfigs) {
        const { longSymbol, shortSymbol } = resolveMonitorSymbols(
          monitorConfig.monitorSymbol,
          monitorContexts,
        );
        if (longSymbol) {
          allTradingSymbols.add(longSymbol);
        }
        if (shortSymbol) {
          allTradingSymbols.add(shortSymbol);
        }
      }

      // 获取所有交易标的的行情
      const quoteMap = await batchGetQuotes(marketDataClient, allTradingSymbols);

      // 为每个监控标的生成清仓信号，然后合并去重
      const allClearanceSignals: Signal[] = [];
      for (const monitorConfig of monitorConfigs) {
        const { longSymbol, shortSymbol } = resolveMonitorSymbols(
          monitorConfig.monitorSymbol,
          monitorContexts,
        );
        const longQuote = longSymbol ? quoteMap.get(longSymbol) ?? null : null;
        const shortQuote = shortSymbol ? quoteMap.get(shortSymbol) ?? null : null;
        // 复用 processPositionForClearance 处理每个持仓
        for (const pos of positions) {
          const signal = processPositionForClearance(
            pos,
            longSymbol,
            shortSymbol,
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
        const availablePositions = positions.filter((pos) => {
          const availableQty = Number(pos?.availableQuantity) || 0;
          return typeof pos?.symbol === 'string' &&
            Number.isFinite(availableQty) &&
            availableQty > 0;
        });
        const seatSymbolSet = new Set(allTradingSymbols);
        const unmatchedPositions = availablePositions.filter(
          (pos) => !seatSymbolSet.has(pos.symbol),
        );
        logClearanceNotice(
          `no-signals:${todayKey}:${positions.length}:${availablePositions.length}:${unmatchedPositions.length}`,
          `[末日保护程序] 清仓跳过：未生成清仓信号（持仓=${positions.length}, 可用持仓=${availablePositions.length}, 非席位持仓=${unmatchedPositions.length}）`,
        );
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
        const { longSymbol, shortSymbol } = resolveMonitorSymbols(
          config.monitorSymbol,
          monitorContexts,
        );
        if (longSymbol) {
          const quote = quoteMap.get(longSymbol) ?? null;
          orderRecorder.clearBuyOrders(longSymbol, true, quote);
        }
        if (shortSymbol) {
          const quote = quoteMap.get(shortSymbol) ?? null;
          orderRecorder.clearBuyOrders(shortSymbol, false, quote);
        }
      }

      return { executed: true, signalCount: uniqueClearanceSignals.length };
    },

    async cancelPendingBuyOrders(
      context: CancelPendingBuyOrdersContext,
    ): Promise<CancelPendingBuyOrdersResult> {
      const {
        currentTime,
        isHalfDay,
        monitorConfigs,
        monitorContexts,
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
      const todayDateString = getHKDateKey(currentTime) ?? currentTime.toISOString().slice(0, 10);
      if (cancelCheckExecutedDate === todayDateString) {
        // 当天已执行过，直接返回
        return { executed: false, cancelledCount: 0 };
      }

      // 收集所有唯一的交易标的
      const allTradingSymbols = new Set<string>();
      for (const monitorConfig of monitorConfigs) {
        const { longSymbol, shortSymbol } = resolveMonitorSymbols(
          monitorConfig.monitorSymbol,
          monitorContexts,
        );
        if (longSymbol) {
          allTradingSymbols.add(longSymbol);
        }
        if (shortSymbol) {
          allTradingSymbols.add(shortSymbol);
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
}

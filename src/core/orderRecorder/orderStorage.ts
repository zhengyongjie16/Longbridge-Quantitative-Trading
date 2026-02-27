/**
 * 订单存储管理模块
 *
 * 职责：
 * - 管理本地订单列表的增删改查
 * - 提供订单查询功能
 * - 追踪待成交卖出订单
 * - 提供可卖订单策略筛选（全量/盈利/超时）
 * - 纯内存操作，无异步方法
 *
 * 优化：
 * - 使用 Map<symbol, OrderRecord[]> 提供 O(1) 查找性能
 * - 避免每次查询都遍历整个数组
 */
import { logger } from '../../utils/logger/index.js';
import { isValidPositiveNumber } from '../../utils/helpers/index.js';
import {
  formatSymbolDisplayFromQuote,
  getLongDirectionName,
  getShortDirectionName,
} from '../utils.js';
import type { Quote } from '../../types/quote.js';
import type { OrderRecord } from '../../types/services.js';
import type {
  OrderStorage,
  OrderStorageDeps,
  PendingSellInfo,
  SellableOrderResult,
  SellableOrderSelectParams,
} from './types.js';
import { calculateOrderStatistics, calculateTotalQuantity, isOrderTimedOut } from './utils.js';
import { deductSellQuantityFromBuyOrders } from './sellDeductionPolicy.js';

/**
 * 创建订单存储管理器（纯内存，无异步）
 * 管理本地订单增删改查、待成交卖单追踪与可卖订单策略筛选，供 orderRecorder 与风控使用。
 * @param _deps 可选依赖，当前未使用
 * @returns OrderStorage 接口实例
 */
export const createOrderStorage = (_deps: OrderStorageDeps = {}): OrderStorage => {
  // 使用 Map 存储订单，key 为 symbol，提供 O(1) 查找性能
  const longBuyOrdersMap: Map<string, OrderRecord[]> = new Map();
  const shortBuyOrdersMap: Map<string, OrderRecord[]> = new Map();
  const longSellRecordMap: Map<string, OrderRecord> = new Map();
  const shortSellRecordMap: Map<string, OrderRecord> = new Map();
  const sellRecordsByOrderId: Map<string, OrderRecord> = new Map();

  // 待成交卖出订单追踪
  const pendingSells = new Map<string, PendingSellInfo>();

  /**
   * 获取指定标的的买入订单列表
   * @param symbol 标的代码
   * @param isLongSymbol 是否为做多标的
   * @returns 买入订单数组（如果不存在则返回空数组）
   */
  const getBuyOrdersList = (symbol: string, isLongSymbol: boolean): ReadonlyArray<OrderRecord> => {
    const targetMap = isLongSymbol ? longBuyOrdersMap : shortBuyOrdersMap;
    const list = targetMap.get(symbol);
    return list ? [...list] : [];
  };

  /**
   * 替换指定标的的买入订单列表（内部辅助函数）
   * @param symbol 标的代码
   * @param newList 新的订单列表
   * @param isLongSymbol 是否为做多标的
   */
  const setBuyOrdersList = (
    symbol: string,
    newList: ReadonlyArray<OrderRecord>,
    isLongSymbol: boolean,
  ): void => {
    const targetMap = isLongSymbol ? longBuyOrdersMap : shortBuyOrdersMap;

    if (newList.length === 0) {
      targetMap.delete(symbol);
    } else {
      targetMap.set(symbol, [...newList]);
    }
  };

  /** 替换做多标的的买入订单列表 */
  const setBuyOrdersListForLong = (symbol: string, newList: ReadonlyArray<OrderRecord>): void => {
    setBuyOrdersList(symbol, newList, true);
  };

  /** 替换做空标的的买入订单列表 */
  const setBuyOrdersListForShort = (symbol: string, newList: ReadonlyArray<OrderRecord>): void => {
    setBuyOrdersList(symbol, newList, false);
  };

  /** 更新指定标的的最新卖出记录（仅保留时间最新的一条） */
  const setLatestSellRecord = (
    symbol: string,
    isLongSymbol: boolean,
    record: OrderRecord,
  ): void => {
    const targetMap = isLongSymbol ? longSellRecordMap : shortSellRecordMap;
    const existing = targetMap.get(symbol);
    if (!existing || record.executedTime >= existing.executedTime) {
      targetMap.set(symbol, record);
    }
    sellRecordsByOrderId.set(record.orderId, record);
  };

  /** 获取指定标的的最新卖出记录 */
  const getLatestSellRecord = (symbol: string, isLongSymbol: boolean): OrderRecord | null => {
    const targetMap = isLongSymbol ? longSellRecordMap : shortSellRecordMap;
    return targetMap.get(symbol) ?? null;
  };

  /** 按订单 ID 获取卖出成交记录 */
  const getSellRecordByOrderId = (orderId: string): OrderRecord | null => {
    return sellRecordsByOrderId.get(orderId) ?? null;
  };

  /**
   * 添加单笔买入订单到本地存储
   * @param symbol 标的代码
   * @param executedPrice 成交价格
   * @param executedQuantity 成交数量
   * @param isLongSymbol 是否为做多标的
   * @param executedTimeMs 成交时间戳（毫秒）
   */
  const addBuyOrder = (
    symbol: string,
    executedPrice: number,
    executedQuantity: number,
    isLongSymbol: boolean,
    executedTimeMs: number,
  ): void => {
    const executedTime = isValidPositiveNumber(executedTimeMs) ? executedTimeMs : Date.now();
    const list = [...getBuyOrdersList(symbol, isLongSymbol)];

    list.push({
      orderId: `LOCAL_${executedTime}`,
      symbol,
      executedPrice,
      executedQuantity,
      executedTime,
      submittedAt: undefined,
      updatedAt: undefined,
    });

    setBuyOrdersList(symbol, list, isLongSymbol);

    const positionType = isLongSymbol ? getLongDirectionName() : getShortDirectionName();
    logger.info(
      `[现存订单记录] 本地新增买入记录：${positionType} ${symbol} 价格=${executedPrice.toFixed(3)} 数量=${executedQuantity}`,
    );
  };

  /**
   * 卖出后更新订单列表
   * - 卖出数量 >= 总数量：清空记录
   * - 否则保留成交价 >= 卖出价的订单
   *
   * @param symbol 标的代码
   * @param executedPrice 成交价格
   * @param executedQuantity 成交数量
   * @param isLongSymbol 是否为做多标的
   * @param executedTimeMs 成交时间戳（毫秒）
   * @param orderId 订单 ID（可选）
   */
  const updateAfterSell = (
    symbol: string,
    executedPrice: number,
    executedQuantity: number,
    isLongSymbol: boolean,
    executedTimeMs: number,
    orderId?: string | null,
  ): void => {
    const list = getBuyOrdersList(symbol, isLongSymbol);
    const executedTime = isValidPositiveNumber(executedTimeMs) ? executedTimeMs : Date.now();

    setLatestSellRecord(symbol, isLongSymbol, {
      orderId: orderId ?? `LOCAL_SELL_${executedTime}`,
      symbol,
      executedPrice,
      executedQuantity,
      executedTime,
      submittedAt: undefined,
      updatedAt: undefined,
    });

    if (list.length === 0) {
      return;
    }

    const totalQuantity = calculateTotalQuantity(list);
    const positionType = isLongSymbol ? getLongDirectionName() : getShortDirectionName();

    // 如果卖出数量大于等于当前记录的总数量，视为全部卖出，清空记录
    if (executedQuantity >= totalQuantity) {
      setBuyOrdersList(symbol, [], isLongSymbol);
      logger.info(
        `[现存订单记录] 本地卖出更新：${positionType} ${symbol} 卖出数量=${executedQuantity} >= 当前记录总数量=${totalQuantity}，清空所有买入记录`,
      );
      return;
    }

    // 否则,使用低价优先整笔消除策略扣减卖出数量
    const filtered = deductSellQuantityFromBuyOrders(list, executedQuantity);
    setBuyOrdersList(symbol, filtered, isLongSymbol);

    const deductedQuantity = calculateTotalQuantity(list) - calculateTotalQuantity(filtered);
    logger.info(
      `[现存订单记录] 本地卖出更新:${positionType} ${symbol} 卖出数量=${executedQuantity},` +
        `低价优先整笔消除后剩余买入记录 ${filtered.length} 笔(消除数量=${deductedQuantity})`,
    );
  };

  /** 清空指定标的的买入订单记录（用于保护性清仓） */
  const clearBuyOrders = (symbol: string, isLongSymbol: boolean, quote?: Quote | null): void => {
    const positionType = isLongSymbol ? getLongDirectionName() : getShortDirectionName();
    setBuyOrdersList(symbol, [], isLongSymbol);

    // 使用 formatSymbolDisplayFromQuote 格式化标的显示
    const symbolDisplay = formatSymbolDisplayFromQuote(quote, symbol);

    logger.info(`[现存订单记录] 清空${positionType} ${symbolDisplay}的所有买入记录（保护性清仓）`);
  };

  /**
   * 获取最新买入订单的成交价（用于买入价格限制检查）
   * @param symbol 标的代码
   * @param isLongSymbol 是否为做多标的
   * @returns 最新成交价，无记录时返回 null
   */
  const getLatestBuyOrderPrice = (symbol: string, isLongSymbol: boolean): number | null => {
    const list = getBuyOrdersList(symbol, isLongSymbol);
    if (list.length === 0) {
      return null;
    }

    let latestOrder: OrderRecord | null = null;
    for (const current of list) {
      if (!latestOrder || current.executedTime > latestOrder.executedTime) {
        latestOrder = current;
      }
    }

    return latestOrder ? latestOrder.executedPrice : null;
  };

  /**
   * 获取指定方向与标的下的全部买入订单（O(1) 查找）。
   */
  function getOrdersByDirectionSymbol(
    symbol: string,
    direction: 'LONG' | 'SHORT',
  ): ReadonlyArray<OrderRecord> {
    const targetMap = direction === 'LONG' ? longBuyOrdersMap : shortBuyOrdersMap;
    return targetMap.get(symbol) ?? [];
  }

  /**
   * 按卖出优先级排序（价格从低到高，时间从早到晚，orderId 字典序）。
   */
  function sortOrdersBySellPriority(
    orders: ReadonlyArray<OrderRecord>,
  ): ReadonlyArray<OrderRecord> {
    return [...orders].sort((a, b) => {
      if (a.executedPrice !== b.executedPrice) {
        return a.executedPrice - b.executedPrice;
      }
      if (a.executedTime !== b.executedTime) {
        return a.executedTime - b.executedTime;
      }
      return a.orderId.localeCompare(b.orderId);
    });
  }

  /**
   * 选择买入价低于当前价的盈利订单。
   */
  function selectProfitOrders(
    allOrders: ReadonlyArray<OrderRecord>,
    currentPrice: number,
  ): ReadonlyArray<OrderRecord> {
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
      return [];
    }

    return allOrders.filter(
      (order) => Number.isFinite(order.executedPrice) && order.executedPrice < currentPrice,
    );
  }

  /**
   * 选择满足超时阈值的订单。
   */
  function selectTimedOutOrders({
    allOrders,
    timeoutMinutes,
    nowMs,
    calendarSnapshot,
  }: {
    allOrders: ReadonlyArray<OrderRecord>;
    timeoutMinutes: number | null;
    nowMs: number;
    calendarSnapshot: SellableOrderSelectParams['calendarSnapshot'];
  }): ReadonlyArray<OrderRecord> {
    if (timeoutMinutes === null || timeoutMinutes < 0) {
      return [];
    }

    if (!calendarSnapshot || !Number.isFinite(nowMs) || nowMs <= 0) {
      return [];
    }

    return allOrders.filter((order) =>
      isOrderTimedOut({
        orderExecutedTimeMs: order.executedTime,
        nowMs,
        timeoutMinutes,
        calendarSnapshot,
      }),
    );
  }

  /** 获取指定标的的成本均价（实时计算，无缓存） */
  const getCostAveragePrice = (symbol: string, isLongSymbol: boolean): number | null => {
    const orders = getBuyOrdersList(symbol, isLongSymbol);
    if (orders.length === 0) {
      return null;
    }
    const stats = calculateOrderStatistics(orders);
    return stats.totalQuantity > 0 ? stats.averagePrice : null;
  };

  // ========== 待成交卖出订单追踪实现 ==========

  /** 添加待成交卖出订单，初始状态为 pending，filledQuantity 为 0 */
  function addPendingSell(info: Omit<PendingSellInfo, 'filledQuantity' | 'status'>): void {
    const record: PendingSellInfo = {
      ...info,
      filledQuantity: 0,
      status: 'pending',
    };
    pendingSells.set(info.orderId, record);

    logger.info(
      `[订单存储] 添加待成交卖出: ${info.orderId} ${info.symbol} ${info.submittedQuantity}股 ` +
        `关联订单=${info.relatedBuyOrderIds.length}个`,
    );
  }

  /** 标记卖出订单完全成交，从 pendingSells 中移除并返回成交记录 */
  function markSellFilled(orderId: string): PendingSellInfo | null {
    const record = pendingSells.get(orderId);
    if (!record) {
      logger.warn(`[订单存储] 找不到待成交卖出订单: ${orderId}`);
      return null;
    }

    const filled: PendingSellInfo = {
      ...record,
      filledQuantity: record.submittedQuantity,
      status: 'filled',
    };

    pendingSells.delete(orderId);

    logger.info(`[订单存储] 卖出订单成交: ${orderId} ${filled.submittedQuantity}股`);

    return filled;
  }

  /** 标记卖出订单部分成交，更新 filledQuantity；若已全部成交则从 pendingSells 中移除 */
  function markSellPartialFilled(orderId: string, filledQuantity: number): PendingSellInfo | null {
    const record = pendingSells.get(orderId);
    if (!record) {
      logger.warn(`[订单存储] 找不到待成交卖出订单: ${orderId}`);
      return null;
    }

    const updated: PendingSellInfo = {
      ...record,
      filledQuantity,
      status: filledQuantity >= record.submittedQuantity ? 'filled' : 'partial',
    };

    if (updated.status === 'filled') {
      pendingSells.delete(orderId);
    } else {
      pendingSells.set(orderId, updated);
    }

    logger.info(
      `[订单存储] 卖出订单部分成交: ${orderId} ${filledQuantity}/${record.submittedQuantity}`,
    );

    return updated;
  }

  /** 标记卖出订单取消，从 pendingSells 中移除并返回取消记录 */
  function markSellCancelled(orderId: string): PendingSellInfo | null {
    const record = pendingSells.get(orderId);
    if (!record) {
      logger.warn(`[订单存储] 找不到待成交卖出订单: ${orderId}`);
      return null;
    }

    // 创建cancelled状态的记录
    const cancelledRecord: PendingSellInfo = {
      ...record,
      status: 'cancelled',
    };

    pendingSells.delete(orderId);

    logger.info(`[订单存储] 卖出订单取消: ${orderId}`);

    return cancelledRecord;
  }

  /** 获取指定标的与方向下所有待成交卖出订单 */
  function getPendingSellOrders(
    symbol: string,
    direction: 'LONG' | 'SHORT',
  ): ReadonlyArray<PendingSellInfo> {
    const orders: PendingSellInfo[] = [];
    for (const order of pendingSells.values()) {
      if (order.symbol === symbol && order.direction === direction) {
        orders.push(order);
      }
    }
    return orders;
  }

  /** 获取全部待成交卖单快照 */
  function getPendingSellSnapshot(): ReadonlyArray<PendingSellInfo> {
    return [...pendingSells.values()];
  }

  /**
   * 恢复期：为待恢复的卖单分配关联买单 ID
   * 从当前买单记录中按价格从低到高分配，排除已被 pendingSells 占用的订单
   */
  function allocateRelatedBuyOrderIdsForRecovery(
    symbol: string,
    direction: 'LONG' | 'SHORT',
    quantity: number,
  ): readonly string[] {
    const isLongSymbol = direction === 'LONG';
    const buyOrders = getBuyOrdersList(symbol, isLongSymbol);

    if (buyOrders.length === 0 || !Number.isFinite(quantity) || quantity <= 0) {
      return [];
    }

    const pendingList = getPendingSellOrders(symbol, direction);
    const occupiedIds = new Set<string>();
    for (const ps of pendingList) {
      for (const id of ps.relatedBuyOrderIds) {
        occupiedIds.add(id);
      }
    }

    const available = buyOrders
      .filter((o) => !occupiedIds.has(o.orderId))
      .sort((a, b) => a.executedPrice - b.executedPrice);

    const result: string[] = [];
    let remaining = quantity;

    for (const order of available) {
      if (remaining <= 0) break;
      const qty = order.executedQuantity;
      if (qty <= 0) continue;

      result.push(order.orderId);
      remaining -= qty;
    }

    return result;
  }

  /** 清空买卖记录与 pendingSells */
  function clearAll(): void {
    longBuyOrdersMap.clear();
    shortBuyOrdersMap.clear();
    longSellRecordMap.clear();
    shortSellRecordMap.clear();
    sellRecordsByOrderId.clear();
    pendingSells.clear();
  }

  /**
   * 按策略筛选可卖订单（统一处理防重、额外排除和整笔截断）。
   */
  function selectSellableOrders(params: SellableOrderSelectParams): SellableOrderResult {
    const {
      symbol,
      direction,
      strategy,
      currentPrice,
      maxSellQuantity,
      excludeOrderIds,
      timeoutMinutes,
      nowMs,
      calendarSnapshot,
    } = params;

    const allOrders = getOrdersByDirectionSymbol(symbol, direction);

    const targetOrders = (() => {
      if (strategy === 'ALL') {
        return allOrders;
      }
      if (strategy === 'PROFIT_ONLY') {
        return selectProfitOrders(allOrders, currentPrice);
      }
      return selectTimedOutOrders({
        allOrders,
        timeoutMinutes: timeoutMinutes ?? null,
        nowMs: typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : 0,
        calendarSnapshot,
      });
    })();

    if (targetOrders.length === 0) {
      return { orders: [], totalQuantity: 0 };
    }

    const pendingSellsList = getPendingSellOrders(symbol, direction);
    const occupiedOrderIds = new Set<string>();

    for (const sellOrder of pendingSellsList) {
      for (const buyOrderId of sellOrder.relatedBuyOrderIds) {
        occupiedOrderIds.add(buyOrderId);
      }
    }

    if (excludeOrderIds) {
      for (const orderId of excludeOrderIds) {
        occupiedOrderIds.add(orderId);
      }
    }

    const availableOrders = targetOrders.filter((order) => !occupiedOrderIds.has(order.orderId));
    if (availableOrders.length === 0) {
      return { orders: [], totalQuantity: 0 };
    }

    const sortedOrders = sortOrdersBySellPriority(availableOrders);
    let totalQuantity = calculateTotalQuantity(sortedOrders);

    if (maxSellQuantity !== undefined && totalQuantity > maxSellQuantity) {
      let remaining = maxSellQuantity;
      const finalOrders: OrderRecord[] = [];

      for (const order of sortedOrders) {
        if (remaining <= 0) {
          break;
        }

        if (order.executedQuantity <= remaining) {
          finalOrders.push(order);
          remaining -= order.executedQuantity;
        }
      }

      totalQuantity = calculateTotalQuantity(finalOrders);
      logger.info(
        `[订单存储] 整笔截断: ${symbol} ${direction} 策略=${strategy} ` +
          `原数量=${calculateTotalQuantity(sortedOrders)} 限制=${maxSellQuantity} 实际=${totalQuantity}`,
      );

      return { orders: finalOrders, totalQuantity };
    }

    logger.debug(
      `[订单存储] 可卖出订单: ${symbol} ${direction} 策略=${strategy} ` +
        `订单数=${sortedOrders.length} 总数=${totalQuantity}`,
    );

    return {
      orders: sortedOrders,
      totalQuantity,
    };
  }

  return {
    getBuyOrdersList,
    setBuyOrdersListForLong,
    setBuyOrdersListForShort,
    addBuyOrder,
    updateAfterSell,
    clearBuyOrders,
    getLatestBuyOrderPrice,
    getLatestSellRecord,
    getSellRecordByOrderId,

    // 待成交卖出订单追踪
    addPendingSell,
    markSellFilled,
    markSellPartialFilled,
    markSellCancelled,
    getPendingSellSnapshot,
    allocateRelatedBuyOrderIdsForRecovery,
    getCostAveragePrice,
    selectSellableOrders,
    clearAll,
  };
};

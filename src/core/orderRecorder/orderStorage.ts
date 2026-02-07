/**
 * 订单存储管理模块
 *
 * 职责：
 * - 管理本地订单列表的增删改查
 * - 提供订单查询功能
 * - 追踪待成交卖出订单
 * - 提供可卖出盈利订单计算
 * - 纯内存操作，无异步方法
 *
 * 优化：
 * - 使用 Map<symbol, OrderRecord[]> 提供 O(1) 查找性能
 * - 避免每次查询都遍历整个数组
 */
import { logger } from '../../utils/logger/index.js';
import { getDirectionName, formatSymbolDisplayFromQuote } from '../../utils/helpers/index.js';
import type { OrderRecord, Quote } from '../../types/index.js';
import type { OrderStorage, OrderStorageDeps, PendingSellInfo, ProfitableOrderResult } from './types.js';
import { calculateTotalQuantity } from './utils.js';

/** 创建订单存储管理器 */
export const createOrderStorage = (_deps: OrderStorageDeps = {}): OrderStorage => {
  // 使用 Map 存储订单，key 为 symbol，提供 O(1) 查找性能
  const longBuyOrdersMap: Map<string, OrderRecord[]> = new Map();
  const shortBuyOrdersMap: Map<string, OrderRecord[]> = new Map();
  const longSellRecordMap: Map<string, OrderRecord> = new Map();
  const shortSellRecordMap: Map<string, OrderRecord> = new Map();

  // 待成交卖出订单追踪
  const pendingSells = new Map<string, PendingSellInfo>();

  /** 获取指定标的的买入订单列表 */
  const getBuyOrdersList = (symbol: string, isLongSymbol: boolean): OrderRecord[] => {
    const targetMap = isLongSymbol ? longBuyOrdersMap : shortBuyOrdersMap;
    return targetMap.get(symbol) ?? [];
  };

  /** 替换指定标的的买入订单列表（内部辅助函数） */
  const setBuyOrdersList = (
    symbol: string,
    newList: ReadonlyArray<OrderRecord>,
    isLongSymbol: boolean,
  ): void => {
    const targetMap = isLongSymbol ? longBuyOrdersMap : shortBuyOrdersMap;

    if (newList.length === 0) {
      targetMap.delete(symbol);
    } else {
      targetMap.set(symbol, newList as OrderRecord[]);
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

  const setLatestSellRecord = (symbol: string, isLongSymbol: boolean, record: OrderRecord): void => {
    const targetMap = isLongSymbol ? longSellRecordMap : shortSellRecordMap;
    const existing = targetMap.get(symbol);
    if (!existing || record.executedTime >= existing.executedTime) {
      targetMap.set(symbol, record);
    }
  };

  const getLatestSellRecord = (symbol: string, isLongSymbol: boolean): OrderRecord | null => {
    const targetMap = isLongSymbol ? longSellRecordMap : shortSellRecordMap;
    return targetMap.get(symbol) ?? null;
  };

  /** 添加单笔买入订单到本地存储 */
  const addBuyOrder = (
    symbol: string,
    executedPrice: number,
    executedQuantity: number,
    isLongSymbol: boolean,
    executedTimeMs: number,
  ): void => {
    const executedTime = Number.isFinite(executedTimeMs) && executedTimeMs > 0
      ? executedTimeMs
      : Date.now();
    const list = getBuyOrdersList(symbol, isLongSymbol);

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

    const positionType = getDirectionName(isLongSymbol);
    logger.info(
      `[现存订单记录] 本地新增买入记录：${positionType} ${symbol} 价格=${executedPrice.toFixed(
        3,
      )} 数量=${executedQuantity}`,
    );
  };

  /**
   * 卖出后更新订单列表
   * - 卖出数量 >= 总数量：清空记录
   * - 否则保留成交价 >= 卖出价的订单
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
    const executedTime = Number.isFinite(executedTimeMs) && executedTimeMs > 0
      ? executedTimeMs
      : Date.now();

    setLatestSellRecord(symbol, isLongSymbol, {
      orderId: orderId ?? `LOCAL_SELL_${executedTime}`,
      symbol,
      executedPrice,
      executedQuantity,
      executedTime,
      submittedAt: undefined,
      updatedAt: undefined,
    });

    if (!list.length) {
      return;
    }

    const totalQuantity = calculateTotalQuantity(list);
    const positionType = getDirectionName(isLongSymbol);

    // 如果卖出数量大于等于当前记录的总数量，视为全部卖出，清空记录
    if (executedQuantity >= totalQuantity) {
      setBuyOrdersList(symbol, [], isLongSymbol);
      logger.info(
        `[现存订单记录] 本地卖出更新：${positionType} ${symbol} 卖出数量=${executedQuantity} >= 当前记录总数量=${totalQuantity}，清空所有买入记录`,
      );
      return;
    }

    // 否则，仅保留成交价 >= 本次卖出价的买入订单
    const filtered = list.filter(
      (order) =>
        Number.isFinite(order.executedPrice) &&
        order.executedPrice >= executedPrice,
    );
    setBuyOrdersList(symbol, filtered, isLongSymbol);
    logger.info(
      `[现存订单记录] 本地卖出更新：${positionType} ${symbol} 卖出数量=${executedQuantity}，按价格过滤后剩余买入记录 ${filtered.length} 笔`,
    );
  };

  /** 清空指定标的的买入订单记录（用于保护性清仓） */
  const clearBuyOrders = (symbol: string, isLongSymbol: boolean, quote?: Quote | null): void => {
    const positionType = getDirectionName(isLongSymbol);
    setBuyOrdersList(symbol, [], isLongSymbol);

    // 使用 formatSymbolDisplayFromQuote 格式化标的显示
    const symbolDisplay = formatSymbolDisplayFromQuote(quote, symbol);

    logger.info(
      `[现存订单记录] 清空${positionType} ${symbolDisplay}的所有买入记录（保护性清仓）`,
    );
  };

  /** 获取最新买入订单的成交价（用于买入价格限制检查） */
  const getLatestBuyOrderPrice = (symbol: string, isLongSymbol: boolean): number | null => {
    const list = getBuyOrdersList(symbol, isLongSymbol);
    if (!list.length) {
      return null;
    }

    const latestOrder = list.reduce<OrderRecord | null>((latest, current) => {
      if (!latest || current.executedTime > latest.executedTime) {
        return current;
      }
      return latest;
    }, null);

    return latestOrder ? latestOrder.executedPrice : null;
  };

  /** 获取买入价低于当前价的订单（用于智能清仓决策） */
  const getBuyOrdersBelowPrice = (
    currentPrice: number,
    direction: 'LONG' | 'SHORT',
    symbol: string,
  ): OrderRecord[] => {
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
      return [];
    }

    const targetMap = direction === 'LONG' ? longBuyOrdersMap : shortBuyOrdersMap;
    const directionName = direction === 'LONG' ? '做多标的' : '做空标的';

    // 获取指定标的的订单（O(1) 查找）
    const allOrders = targetMap.get(symbol) ?? [];

    const filteredOrders = allOrders.filter(
      (order) =>
        Number.isFinite(order.executedPrice) &&
        order.executedPrice < currentPrice,
    );

    logger.debug(
      `[根据订单记录过滤] ${directionName} ${symbol}，当前价格=${currentPrice}，当前订单=${JSON.stringify(
        allOrders,
      )}，过滤后订单=${JSON.stringify(filteredOrders)}`,
    );

    return filteredOrders;
  };

  /** 获取所有做多标的的买入订单（用于 RiskChecker） */
  const getLongBuyOrders = (): OrderRecord[] => {
    let totalLength = 0;
    for (const orders of longBuyOrdersMap.values()) {
      totalLength += orders.length;
    }
    if (totalLength === 0) {
      return [];
    }

    const allOrders = new Array<OrderRecord>(totalLength);
    let offset = 0;
    for (const orders of longBuyOrdersMap.values()) {
      for (const order of orders) {
        allOrders[offset] = order;
        offset += 1;
      }
    }
    return allOrders;
  };

  /** 获取所有做空标的的买入订单（用于 RiskChecker） */
  const getShortBuyOrders = (): OrderRecord[] => {
    let totalLength = 0;
    for (const orders of shortBuyOrdersMap.values()) {
      totalLength += orders.length;
    }
    if (totalLength === 0) {
      return [];
    }

    const allOrders = new Array<OrderRecord>(totalLength);
    let offset = 0;
    for (const orders of shortBuyOrdersMap.values()) {
      for (const order of orders) {
        allOrders[offset] = order;
        offset += 1;
      }
    }
    return allOrders;
  };

  // 待成交卖出订单追踪实现

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

    logger.info(
      `[订单存储] 卖出订单成交: ${orderId} ${filled.submittedQuantity}股`,
    );

    return filled;
  }

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

  function markSellCancelled(orderId: string): PendingSellInfo | null {
    const record = pendingSells.get(orderId);
    if (!record) {
      logger.warn(`[订单存储] 找不到待成交卖出订单: ${orderId}`);
      return null;
    }

    pendingSells.delete(orderId);

    logger.info(`[订单存储] 卖出订单取消: ${orderId}`);

    return record;
  }

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

  // ========== 核心：可卖出盈利订单计算（防重逻辑） ==========

  function getProfitableSellOrders(
    symbol: string,
    direction: 'LONG' | 'SHORT',
    currentPrice: number,
    maxSellQuantity?: number,
  ): ProfitableOrderResult {
    // 1. 获取所有盈利订单（买入价 < 当前价）
    const profitableOrders = getBuyOrdersBelowPrice(currentPrice, direction, symbol);

    if (profitableOrders.length === 0) {
      return { orders: [], totalQuantity: 0 };
    }

    // 2. 获取已被待成交卖出订单占用的订单ID
    const pendingSellsList = getPendingSellOrders(symbol, direction);
    const occupiedOrderIds = new Set<string>();

    for (const sellOrder of pendingSellsList) {
      for (const buyOrderId of sellOrder.relatedBuyOrderIds) {
        occupiedOrderIds.add(buyOrderId);
      }
    }

    // 3. 过滤掉被占用的订单
    const availableOrders = profitableOrders.filter(
      (order) => !occupiedOrderIds.has(order.orderId),
    );

    // 4. 计算可用数量
    let totalQuantity = calculateTotalQuantity(availableOrders);

    // 5. 数量截断（如果超过最大可卖数量）
    if (maxSellQuantity !== undefined && totalQuantity > maxSellQuantity) {
      // 按价格从低到高排序（便宜的先卖）
      availableOrders.sort((a, b) => a.executedPrice - b.executedPrice);

      let remaining = maxSellQuantity;
      const finalOrders: OrderRecord[] = [];

      for (const order of availableOrders) {
        if (remaining <= 0) break;
        if (order.executedQuantity <= remaining) {
          finalOrders.push(order);
          remaining -= order.executedQuantity;
        } else {
          // 部分数量
          finalOrders.push({
            ...order,
            executedQuantity: remaining,
          });
          remaining = 0;
        }
      }

      totalQuantity = maxSellQuantity;

      logger.info(
        `[订单存储] 数量超出限制截断: ${symbol} ${direction} ` +
        `原数量=${calculateTotalQuantity(availableOrders)} ` +
        `限制=${maxSellQuantity} 最终=${totalQuantity}`,
      );

      return { orders: finalOrders, totalQuantity };
    }

    logger.debug(
      `[订单存储] 可卖出盈利订单: ${symbol} ${direction} ` +
      `订单数=${availableOrders.length} 总数=${totalQuantity}`,
    );

    return {
      orders: availableOrders,
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
    getBuyOrdersBelowPrice,
    calculateTotalQuantity,
    getLongBuyOrders,
    getShortBuyOrders,

    // 待成交卖出订单追踪
    addPendingSell,
    markSellFilled,
    markSellPartialFilled,
    markSellCancelled,
    getPendingSellOrders,
    getProfitableSellOrders,
  };
};

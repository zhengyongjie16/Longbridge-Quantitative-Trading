/**
 * 订单存储管理模块
 *
 * 职责：
 * - 管理本地订单列表的增删改查
 * - 提供订单查询功能
 * - 纯内存操作，无异步方法
 *
 * 优化：
 * - 使用 Map<symbol, OrderRecord[]> 提供 O(1) 查找性能
 * - 避免每次查询都遍历整个数组
 */

import { logger } from '../../utils/logger/index.js';
import { getDirectionName, formatSymbolDisplayFromQuote } from '../../utils/helpers/index.js';
import type { OrderRecord, Quote } from '../../types/index.js';
import type { OrderStorage, OrderStorageDeps } from './types.js';
import { calculateTotalQuantity } from './utils.js';

/** 创建订单存储管理器 */
export const createOrderStorage = (_deps: OrderStorageDeps = {}): OrderStorage => {
  // 使用 Map 存储订单，key 为 symbol，提供 O(1) 查找性能
  const longBuyOrdersMap: Map<string, OrderRecord[]> = new Map();
  const shortBuyOrdersMap: Map<string, OrderRecord[]> = new Map();
  const longSellRecordMap: Map<string, OrderRecord> = new Map();
  const shortSellRecordMap: Map<string, OrderRecord> = new Map();

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
  };
};

/**
 * 订单存储管理模块
 *
 * 职责：
 * - 管理本地订单列表的增删改查
 * - 提供订单查询功能
 * - 纯内存操作，无异步方法
 */

import { logger } from '../../utils/logger.js';
import {
  normalizeHKSymbol,
  getDirectionName,
} from '../../utils/helpers.js';
import type { OrderRecord } from './type.js';

export class OrderStorage {
  private _longBuyOrders: OrderRecord[];
  private _shortBuyOrders: OrderRecord[];

  constructor() {
    this._longBuyOrders = [];
    this._shortBuyOrders = [];
  }

  /**
   * 获取指定标的的买入订单列表
   */
  getBuyOrdersList(symbol: string, isLongSymbol: boolean): OrderRecord[] {
    const targetList = isLongSymbol
      ? this._longBuyOrders
      : this._shortBuyOrders;
    return targetList.filter((order) => order.symbol === symbol);
  }

  /**
   * 替换指定标的的买入订单列表
   */
  setBuyOrdersList(
    symbol: string,
    isLongSymbol: boolean,
    newList: OrderRecord[],
  ): void {
    if (isLongSymbol) {
      this._longBuyOrders = [
        ...this._longBuyOrders.filter((o) => o.symbol !== symbol),
        ...newList,
      ];
    } else {
      this._shortBuyOrders = [
        ...this._shortBuyOrders.filter((o) => o.symbol !== symbol),
        ...newList,
      ];
    }
  }

  /**
   * 添加单笔买入订单
   */
  addBuyOrder(
    symbol: string,
    executedPrice: number,
    executedQuantity: number,
    isLongSymbol: boolean,
  ): void {
    const normalizedSymbol = normalizeHKSymbol(symbol);
    const now = Date.now();
    const list = this.getBuyOrdersList(normalizedSymbol, isLongSymbol);

    list.push({
      orderId: `LOCAL_${now}`,
      symbol: normalizedSymbol,
      executedPrice,
      executedQuantity,
      executedTime: now,
      submittedAt: undefined,
      updatedAt: undefined,
    });

    this.setBuyOrdersList(normalizedSymbol, isLongSymbol, list);

    const positionType = getDirectionName(isLongSymbol);
    logger.info(
      `[现存订单记录] 本地新增买入记录：${positionType} ${normalizedSymbol} 价格=${executedPrice.toFixed(
        3,
      )} 数量=${executedQuantity}`,
    );
  }

  /**
   * 卖出后更新订单列表
   *
   * 规则：
   * 1. 如果本地买入记录的总数量 <= 本次卖出数量，认为全部卖出，清空记录
   * 2. 否则，仅保留成交价 >= 本次卖出价的买入订单
   */
  updateAfterSell(
    symbol: string,
    executedPrice: number,
    executedQuantity: number,
    isLongSymbol: boolean,
  ): void {
    const normalizedSymbol = normalizeHKSymbol(symbol);
    const list = this.getBuyOrdersList(normalizedSymbol, isLongSymbol);

    if (!list.length) {
      return;
    }

    const totalQuantity = this.calculateTotalQuantity(list);
    const positionType = getDirectionName(isLongSymbol);

    // 如果卖出数量大于等于当前记录的总数量，视为全部卖出，清空记录
    if (executedQuantity >= totalQuantity) {
      this.setBuyOrdersList(normalizedSymbol, isLongSymbol, []);
      logger.info(
        `[现存订单记录] 本地卖出更新：${positionType} ${normalizedSymbol} 卖出数量=${executedQuantity} >= 当前记录总数量=${totalQuantity}，清空所有买入记录`,
      );
      return;
    }

    // 否则，仅保留成交价 >= 本次卖出价的买入订单
    const filtered = list.filter(
      (order) =>
        Number.isFinite(order.executedPrice) &&
        order.executedPrice >= executedPrice,
    );
    this.setBuyOrdersList(normalizedSymbol, isLongSymbol, filtered);
    logger.info(
      `[现存订单记录] 本地卖出更新：${positionType} ${normalizedSymbol} 卖出数量=${executedQuantity}，按价格过滤后剩余买入记录 ${filtered.length} 笔`,
    );
  }

  /**
   * 清空指定标的的买入订单记录（用于保护性清仓等无条件清仓场景）
   */
  clearBuyOrders(symbol: string, isLongSymbol: boolean): void {
    const normalizedSymbol = normalizeHKSymbol(symbol);
    const positionType = getDirectionName(isLongSymbol);
    this.setBuyOrdersList(normalizedSymbol, isLongSymbol, []);
    logger.info(
      `[现存订单记录] 清空${positionType} ${normalizedSymbol}的所有买入记录（保护性清仓）`,
    );
  }

  /**
   * 获取最新买入订单的成交价（用于买入价格限制检查）
   */
  getLatestBuyOrderPrice(symbol: string, isLongSymbol: boolean): number | null {
    const normalizedSymbol = normalizeHKSymbol(symbol);
    const list = this.getBuyOrdersList(normalizedSymbol, isLongSymbol);
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
  }

  /**
   * 根据当前价格获取做多标的或做空标的中买入价低于当前价的订单
   */
  getBuyOrdersBelowPrice(
    currentPrice: number,
    direction: 'LONG' | 'SHORT',
  ): OrderRecord[] {
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
      return [];
    }

    const buyOrders =
      direction === 'LONG' ? this._longBuyOrders : this._shortBuyOrders;
    const directionName = direction === 'LONG' ? '做多标的' : '做空标的';

    const filteredOrders = buyOrders.filter(
      (order) =>
        Number.isFinite(order.executedPrice) &&
        order.executedPrice < currentPrice,
    );

    logger.debug(
      `[根据订单记录过滤] ${directionName}，当前价格=${currentPrice}，当前订单=${JSON.stringify(
        buyOrders,
      )}，过滤后订单=${JSON.stringify(filteredOrders)}`,
    );

    return filteredOrders;
  }

  /**
   * 计算订单列表的总成交数量
   */
  calculateTotalQuantity(orders: OrderRecord[]): number {
    return orders.reduce((sum, order) => {
      return sum + (order.executedQuantity || 0);
    }, 0);
  }

  /**
   * 暴露给外部访问的 getter（用于 RiskChecker）
   */
  getLongBuyOrders(): OrderRecord[] {
    return this._longBuyOrders;
  }

  getShortBuyOrders(): OrderRecord[] {
    return this._shortBuyOrders;
  }
}

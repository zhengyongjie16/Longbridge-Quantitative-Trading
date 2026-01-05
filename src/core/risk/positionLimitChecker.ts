/**
 * 持仓市值限制检查模块
 *
 * 功能：
 * - 检查下单金额是否超过限制
 * - 检查持仓市值是否超过限制
 * - 计算持仓市值
 */

import { normalizeHKSymbol } from '../../utils/helpers.js';
import type { Position, Signal } from '../../types/index.js';
import type { RiskCheckResult } from './type.js';

/**
 * 持仓市值限制检查器
 */
export class PositionLimitChecker {
  private readonly maxPositionNotional: number | null;

  constructor(maxPositionNotional: number | null) {
    this.maxPositionNotional = maxPositionNotional;
  }

  /**
   * 检查单标的最大持仓市值限制
   * @param signal 信号对象
   * @param positions 持仓列表
   * @param orderNotional 计划下单金额
   * @param currentPrice 标的当前市价
   */
  checkLimit(
    signal: Signal,
    positions: Position[] | null,
    orderNotional: number,
    currentPrice: number | null,
  ): RiskCheckResult {
    // 验证下单金额有效性
    if (!Number.isFinite(orderNotional) || orderNotional < 0) {
      return {
        allowed: false,
        reason: `计划下单金额无效：${orderNotional}`,
      };
    }

    // 检查下单金额是否超过限制（无持仓时）
    if (this.maxPositionNotional !== null && orderNotional > this.maxPositionNotional) {
      return {
        allowed: false,
        reason: `本次计划下单金额 ${orderNotional.toFixed(
          2,
        )} HKD 超过单标的最大持仓市值限制 ${this.maxPositionNotional} HKD`,
      };
    }

    const symbol = signal.symbol;
    const pos = this._findPosition(positions, symbol);

    // 如果没有持仓，直接通过（下单金额已在上面检查）
    if (!pos?.quantity || pos.quantity <= 0) {
      return { allowed: true };
    }

    // 检查有持仓时的市值限制
    return this._checkWithExistingHoldings(pos, orderNotional, currentPrice);
  }

  /**
   * 查找持仓
   * @private
   */
  private _findPosition(
    positions: Position[] | null,
    symbol: string,
  ): Position | undefined {
    return positions?.find((p) => {
      const posSymbol = normalizeHKSymbol(p.symbol);
      const sigSymbol = normalizeHKSymbol(symbol);
      return posSymbol === sigSymbol;
    });
  }

  /**
   * 检查有持仓时的市值限制
   * @private
   */
  private _checkWithExistingHoldings(
    pos: Position,
    orderNotional: number,
    currentPrice: number | null,
  ): RiskCheckResult {
    // 验证持仓数量有效性
    const posQuantity = Number(pos.quantity) || 0;
    if (!Number.isFinite(posQuantity) || posQuantity <= 0) {
      // 持仓数量无效，只检查下单金额
      return this._checkOrderNotionalOnly(orderNotional);
    }

    // 若已有持仓应以成本价计算当前持仓市值（用户要求）
    // 优先使用成本价，如果没有成本价则使用当前市价
    const price = pos.costPrice ?? currentPrice ?? 0;

    // 验证价格有效性
    if (!Number.isFinite(price) || price <= 0) {
      // 价格无效，只检查下单金额
      return this._checkOrderNotionalOnly(orderNotional);
    }

    const currentNotional = posQuantity * price;
    const totalNotional = currentNotional + orderNotional;

    if (!Number.isFinite(totalNotional)) {
      return {
        allowed: false,
        reason: `持仓市值计算错误：数量=${posQuantity} × 价格=${price}`,
      };
    }

    if (this.maxPositionNotional !== null && totalNotional > this.maxPositionNotional) {
      return {
        allowed: false,
        reason: `该标的当前持仓市值约 ${currentNotional.toFixed(
          2,
        )} HKD（数量=${posQuantity} × 价格=${price.toFixed(
          3,
        )}），加上本次计划下单 ${orderNotional.toFixed(
          2,
        )} HKD 将超过单标的最大持仓市值限制 ${this.maxPositionNotional} HKD`,
      };
    }

    return { allowed: true };
  }

  /**
   * 仅检查下单金额
   * @private
   */
  private _checkOrderNotionalOnly(orderNotional: number): RiskCheckResult {
    if (this.maxPositionNotional !== null && orderNotional > this.maxPositionNotional) {
      return {
        allowed: false,
        reason: `本次计划下单金额 ${orderNotional.toFixed(
          2,
        )} HKD 超过单标的最大持仓市值限制 ${this.maxPositionNotional} HKD`,
      };
    }
    return { allowed: true };
  }
}

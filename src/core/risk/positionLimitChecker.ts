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
import type { RiskCheckResult, PositionLimitChecker, PositionLimitCheckerDeps } from './type.js';

/**
 * 创建持仓市值限制检查器
 * @param deps 依赖注入
 * @returns PositionLimitChecker 接口实例
 */
export const createPositionLimitChecker = (deps: PositionLimitCheckerDeps): PositionLimitChecker => {
  const maxPositionNotional = deps.maxPositionNotional;

  /**
   * 查找持仓
   */
  const findPosition = (
    positions: ReadonlyArray<Position> | null,
    symbol: string,
  ): Position | undefined => {
    return positions?.find((p) => {
      const posSymbol = normalizeHKSymbol(p.symbol);
      const sigSymbol = normalizeHKSymbol(symbol);
      return posSymbol === sigSymbol;
    });
  };

  /**
   * 仅检查下单金额
   */
  const checkOrderNotionalOnly = (orderNotional: number): RiskCheckResult => {
    if (maxPositionNotional !== null && orderNotional > maxPositionNotional) {
      return {
        allowed: false,
        reason: `本次计划下单金额 ${orderNotional.toFixed(
          2,
        )} HKD 超过单标的最大持仓市值限制 ${maxPositionNotional} HKD`,
      };
    }
    return { allowed: true };
  };

  /**
   * 检查有持仓时的市值限制
   */
  const checkWithExistingHoldings = (
    pos: Position,
    orderNotional: number,
    currentPrice: number | null,
  ): RiskCheckResult => {
    // 验证持仓数量有效性
    const posQuantity = Number(pos.quantity) || 0;
    if (!Number.isFinite(posQuantity) || posQuantity <= 0) {
      // 持仓数量无效，只检查下单金额
      return checkOrderNotionalOnly(orderNotional);
    }

    // 若已有持仓应以成本价计算当前持仓市值（用户要求）
    // 优先使用成本价，如果没有成本价则使用当前市价
    const price = pos.costPrice ?? currentPrice ?? 0;

    // 验证价格有效性
    if (!Number.isFinite(price) || price <= 0) {
      // 价格无效，只检查下单金额
      return checkOrderNotionalOnly(orderNotional);
    }

    const currentNotional = posQuantity * price;
    const totalNotional = currentNotional + orderNotional;

    if (!Number.isFinite(totalNotional)) {
      return {
        allowed: false,
        reason: `持仓市值计算错误：数量=${posQuantity} × 价格=${price}`,
      };
    }

    if (maxPositionNotional !== null && totalNotional > maxPositionNotional) {
      return {
        allowed: false,
        reason: `该标的当前持仓市值约 ${currentNotional.toFixed(
          2,
        )} HKD（数量=${posQuantity} × 价格=${price.toFixed(
          3,
        )}），加上本次计划下单 ${orderNotional.toFixed(
          2,
        )} HKD 将超过单标的最大持仓市值限制 ${maxPositionNotional} HKD`,
      };
    }

    return { allowed: true };
  };

  /**
   * 检查单标的最大持仓市值限制
   */
  const checkLimit = (
    signal: Signal,
    positions: Position[] | null,
    orderNotional: number,
    currentPrice: number | null,
  ): RiskCheckResult => {
    // 验证下单金额有效性
    if (!Number.isFinite(orderNotional) || orderNotional < 0) {
      return {
        allowed: false,
        reason: `计划下单金额无效：${orderNotional}`,
      };
    }

    // 检查下单金额是否超过限制（无持仓时）
    if (maxPositionNotional !== null && orderNotional > maxPositionNotional) {
      return {
        allowed: false,
        reason: `本次计划下单金额 ${orderNotional.toFixed(
          2,
        )} HKD 超过单标的最大持仓市值限制 ${maxPositionNotional} HKD`,
      };
    }

    const symbol = signal.symbol;
    const pos = findPosition(positions, symbol);

    // 如果没有持仓，直接通过（下单金额已在上面检查）
    if (!pos?.quantity || pos.quantity <= 0) {
      return { allowed: true };
    }

    // 检查有持仓时的市值限制
    return checkWithExistingHoldings(pos, orderNotional, currentPrice);
  };

  return {
    checkLimit,
  };
};

/**
 * 浮亏检查模块
 *
 * 监控单标的浮亏，超过阈值时触发保护性清仓：
 * - R1 = 开仓成本（未平仓买入订单的市值总和）
 * - N1 = 持仓数量（未平仓买入订单的成交数量总和）
 * - R2 = 当前市值（当前价格 × N1）
 * - 浮亏 = R2 - R1（负值表示亏损）
 */

import { logger } from '../../utils/logger/index.js';
import { isValidPositiveNumber, getDirectionName, formatSymbolDisplayFromQuote } from '../../utils/helpers/index.js';
import type { OrderRecorder, UnrealizedLossData, UnrealizedLossCheckResult, Quote } from '../../types/index.js';
import type { UnrealizedLossChecker, UnrealizedLossCheckerDeps } from './types.js';

/** 创建浮亏检查器 */
export const createUnrealizedLossChecker = (deps: UnrealizedLossCheckerDeps): UnrealizedLossChecker => {
  const maxUnrealizedLossPerSymbol = deps.maxUnrealizedLossPerSymbol;

  // 闭包捕获的私有状态
  const unrealizedLossData = new Map<string, UnrealizedLossData>();

  /** 获取指定标的的浮亏数据 */
  const getUnrealizedLossData = (symbol: string): UnrealizedLossData | undefined => {
    return unrealizedLossData.get(symbol);
  };

  /** 获取所有标的的浮亏数据（返回副本） */
  const getAllData = (): ReadonlyMap<string, UnrealizedLossData> => {
    return new Map(unrealizedLossData.entries());
  };

  /** 检查浮亏保护是否启用 */
  const isEnabled = (): boolean => {
    return (
      maxUnrealizedLossPerSymbol !== null &&
      Number.isFinite(maxUnrealizedLossPerSymbol) &&
      maxUnrealizedLossPerSymbol > 0
    );
  };

  /** 从订单列表计算 R1（开仓成本）和 N1（持仓数量） */
  const calculateCostAndQuantity = (
    buyOrders: Array<{ executedPrice: number | string; executedQuantity: number | string }>,
  ): { r1: number; n1: number } => {
    let r1 = 0;
    let n1 = 0;

    for (const order of buyOrders) {
      const price = Number(order.executedPrice) || 0;
      const quantity = Number(order.executedQuantity) || 0;

      if (
        Number.isFinite(price) &&
        price > 0 &&
        Number.isFinite(quantity) &&
        quantity > 0
      ) {
        r1 += price * quantity;
        n1 += quantity;
      }
    }

    return { r1, n1 };
  };

  /** 刷新标的的浮亏数据（启动时或交易后调用） */
  const refresh = async (
    orderRecorder: OrderRecorder,
    symbol: string,
    isLongSymbol: boolean,
    quote?: Quote | null,
    dailyLossOffset?: number,
  ): Promise<{ r1: number; n1: number } | null> => {
    // 如果未启用浮亏保护，跳过
    if (!isEnabled()) {
      return null;
    }

    if (!orderRecorder) {
      const symbolDisplay = formatSymbolDisplayFromQuote(quote, symbol);
      logger.warn(
        `[浮亏监控] 未提供 OrderRecorder 实例，无法刷新标的 ${symbolDisplay} 的浮亏数据`,
      );
      return null;
    }

    try {
      // 使用公共方法获取订单列表
      const buyOrders = orderRecorder.getBuyOrdersForSymbol(
        symbol,
        isLongSymbol,
      );

      // 计算R1（开仓成本）和N1（持仓数量）
      const { r1: baseR1, n1 } = calculateCostAndQuantity(buyOrders);
      const normalizedOffset =
        dailyLossOffset != null && Number.isFinite(dailyLossOffset)
          ? dailyLossOffset
          : 0;
      const adjustedR1 = baseR1 + normalizedOffset;

      // 更新缓存
      unrealizedLossData.set(symbol, {
        r1: adjustedR1,
        n1,
        baseR1,
        dailyLossOffset: normalizedOffset,
        lastUpdateTime: Date.now(),
      });

      const positionType = getDirectionName(isLongSymbol);

      // 使用 formatSymbolDisplayFromQuote 格式化标的显示
      const symbolDisplay = formatSymbolDisplayFromQuote(quote, symbol);

      if (normalizedOffset !== 0) {
        logger.info(
          `[浮亏监控] ${positionType} ${symbolDisplay}: ` +
            `R1(开仓成本)=${baseR1.toFixed(2)} HKD, ` +
            `当日偏移=${normalizedOffset.toFixed(2)} HKD, ` +
            `调整后R1=${adjustedR1.toFixed(2)} HKD, ` +
            `N1(持仓数量)=${n1}, 未平仓订单数=${buyOrders.length}`,
        );
      } else {
        logger.info(
          `[浮亏监控] ${positionType} ${symbolDisplay}: R1(开仓成本)=${baseR1.toFixed(
            2,
          )} HKD, N1(持仓数量)=${n1}, 未平仓订单数=${buyOrders.length}`,
        );
      }

      return { r1: adjustedR1, n1 };
    } catch (error) {
      const symbolDisplay = formatSymbolDisplayFromQuote(quote, symbol);
      logger.error(
        `[浮亏监控] 刷新标的 ${symbolDisplay} 的浮亏数据失败`,
        (error as Error).message || String(error),
      );
      return null;
    }
  };

  /** 检查浮亏是否超过阈值，超过则返回清仓信号 */
  const check = (
    symbol: string,
    currentPrice: number,
    isLongSymbol: boolean,
  ): UnrealizedLossCheckResult => {
    // 如果未启用浮亏保护，跳过
    if (!isEnabled()) {
      return { shouldLiquidate: false };
    }

    // 验证当前价格有效性
    if (!isValidPositiveNumber(currentPrice)) {
      return { shouldLiquidate: false };
    }

    // 获取缓存的浮亏数据
    const lossData = unrealizedLossData.get(symbol);
    if (!lossData) {
      logger.warn(
        `[浮亏监控] ${symbol} 浮亏数据未初始化，跳过检查（可能是订单获取失败或数据尚未刷新）`,
      );
      return { shouldLiquidate: false };
    }

    const { r1, n1 } = lossData;

    // 如果剩余数量为0或负数，无需清仓
    if (!Number.isFinite(n1) || n1 <= 0) {
      return { shouldLiquidate: false };
    }

    // 计算当前持仓市值R2和浮亏
    const r2 = currentPrice * n1;
    const unrealizedLoss = r2 - r1;

    // 检查浮亏是否超过阈值（浮亏为负数表示亏损）
    // 此处已通过 isEnabled() 验证，maxUnrealizedLossPerSymbol 不为 null
    if (maxUnrealizedLossPerSymbol === null || !Number.isFinite(maxUnrealizedLossPerSymbol)) {
      return { shouldLiquidate: false };
    }

    if (unrealizedLoss < -maxUnrealizedLossPerSymbol) {
      const positionType = getDirectionName(isLongSymbol);
      const reason = `[保护性清仓] ${positionType} ${symbol} 浮亏=${unrealizedLoss.toFixed(
        2,
      )} HKD 超过阈值 ${maxUnrealizedLossPerSymbol} HKD (R1=${r1.toFixed(
        2,
      )}, R2=${r2.toFixed(2)}, N1=${n1})，执行保护性清仓`;

      logger.warn(reason);

      return {
        shouldLiquidate: true,
        reason,
        quantity: n1,
      };
    }

    return { shouldLiquidate: false };
  };

  return {
    getUnrealizedLossData,
    getAllData,
    isEnabled,
    refresh,
    check,
  };
};

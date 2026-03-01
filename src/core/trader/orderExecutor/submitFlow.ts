/**
 * orderExecutor 提交流程模块
 *
 * 职责：
 * - 计算买卖数量并完成卖单合并决策
 * - 构造订单载荷并提交到 Trade API
 * - 在提交成功后注册 orderMonitor 追踪与卖单防重占用
 */
import { OrderSide, OrderType, TimeInForceType, type TradeContext } from 'longport';
import { logger } from '../../../utils/logger/index.js';
import { TRADING } from '../../../constants/index.js';
import { decimalToNumber, isValidPositiveNumber } from '../../../utils/helpers/index.js';
import { formatSymbolDisplay } from '../../../utils/display/index.js';
import type { MonitorConfig } from '../../../types/config.js';
import type { Signal } from '../../../types/signal.js';
import type { OrderPayload, SubmitOrderParams } from '../types.js';
import {
  extractOrderId,
  formatOrderTypeLabel,
  getOrderTypeCode,
  resolveOrderTypeConfig,
  resolveSellMergeDecision,
  toDecimal,
} from '../utils.js';
import type { SubmitTargetOrder, SubmitTargetOrderDeps } from './types.js';
import {
  getActionDescription,
  getOrderTypeFromConfig,
  handleSubmitError,
  isLiquidationSignal,
  resolveOrderSide,
} from './utils.js';
import { createQuantityResolver } from './quantityResolver.js';

/**
 * 创建 submitTargetOrder 实现。
 *
 * @param deps 提交流程依赖
 * @returns 目标订单提交函数
 */
export function createSubmitTargetOrder(deps: SubmitTargetOrderDeps): SubmitTargetOrder {
  const {
    rateLimiter,
    cacheManager,
    orderMonitor,
    orderRecorder,
    globalConfig,
    canExecuteSignal,
    updateLastBuyTime,
  } = deps;
  const quantityResolver = createQuantityResolver({ rateLimiter });

  /**
   * 根据全局配置与信号属性解析最终订单类型。
   *
   * @param signal 交易信号
   * @returns LongPort 订单类型
   */
  function resolveOrderType(signal: Signal): OrderType {
    const orderTypeConfig = resolveOrderTypeConfig(signal, globalConfig);
    return getOrderTypeFromConfig(orderTypeConfig);
  }

  /**
   * 提交订单并在成功后登记运行态追踪。
   *
   * @param params 提交参数
   * @returns 订单 ID，失败返回 null
   */
  async function submitOrder(params: SubmitOrderParams): Promise<string | null> {
    const {
      ctx,
      signal,
      symbol,
      side,
      submittedQtyDecimal,
      orderTypeParam,
      timeInForce,
      remark,
      overridePrice,
      isShortSymbol,
      monitorConfig = null,
    } = params;

    if (!canExecuteSignal(signal, 'submitOrder')) {
      return null;
    }

    const resolvedPrice = overridePrice ?? signal.price ?? null;
    const symbolDisplayForLog = formatSymbolDisplay(symbol, signal.symbolName ?? null);

    if (orderTypeParam === OrderType.MO) {
      logger.info(`[订单类型] 使用市价单(MO)，标的=${symbolDisplayForLog}`);
    } else if (orderTypeParam === OrderType.LO || orderTypeParam === OrderType.ELO) {
      const orderTypeLabel = formatOrderTypeLabel(orderTypeParam);
      if (!resolvedPrice) {
        logger.warn(
          `[跳过订单] ${symbolDisplayForLog} 的${orderTypeLabel}缺少价格，无法提交。请确保信号中包含价格信息`,
        );
        return null;
      }
      const orderTypeCode = getOrderTypeCode(orderTypeParam);
      logger.info(
        `[订单类型] 使用${orderTypeLabel}(${orderTypeCode})，标的=${symbolDisplayForLog}，价格=${resolvedPrice}`,
      );
    }

    const orderPayload: OrderPayload = {
      symbol,
      orderType: orderTypeParam,
      side,
      timeInForce,
      submittedQuantity: submittedQtyDecimal,
      ...(resolvedPrice &&
        orderTypeParam !== OrderType.MO && { submittedPrice: toDecimal(resolvedPrice) }),
      ...(remark && { remark: remark.slice(0, 60) }),
    };

    try {
      await rateLimiter.throttle();
      if (!canExecuteSignal(signal, 'submitOrder.beforeApi')) {
        return null;
      }
      const resp = await ctx.submitOrder(orderPayload);
      cacheManager.clearCache();
      const orderId = extractOrderId(resp);
      const actionDesc = getActionDescription(signal.action);
      logger.info(
        `[订单提交成功] ${actionDesc} ${orderPayload.symbol} 数量=${orderPayload.submittedQuantity.toString()} 订单ID=${orderId}`,
      );

      const submittedQuantityNum = decimalToNumber(orderPayload.submittedQuantity);
      const isLongSymbol = !isShortSymbol;
      const isProtectiveLiquidation = isLiquidationSignal(signal);
      orderMonitor.trackOrder({
        orderId,
        symbol,
        side,
        price: resolvedPrice ?? 0,
        quantity: submittedQuantityNum,
        isLongSymbol,
        monitorSymbol: monitorConfig?.monitorSymbol ?? null,
        isProtectiveLiquidation,
        orderType: orderTypeParam,
      });

      if (side === OrderSide.Sell && signal.relatedBuyOrderIds) {
        const direction: 'LONG' | 'SHORT' = isLongSymbol ? 'LONG' : 'SHORT';
        orderRecorder.submitSellOrder(
          orderId,
          symbol,
          direction,
          submittedQuantityNum,
          signal.relatedBuyOrderIds,
        );
      }

      updateLastBuyTime(signal.action, monitorConfig);
      return orderId;
    } catch (err) {
      handleSubmitError(err, signal, orderPayload);
      return null;
    }
  }

  /**
   * 根据信号构建并提交订单。
   * 卖出分支包含卖单合并（REPLACE/CANCEL_AND_SUBMIT/SUBMIT/SKIP）。
   *
   * @param ctx TradeContext
   * @param signal 交易信号
   * @param targetSymbol 目标标的
   * @param isShortSymbol 是否为空头方向标的
   * @param monitorConfig 监控配置
   * @returns 已提交订单 ID，未提交返回 null
   */
  return async function submitTargetOrder(
    ctx: TradeContext,
    signal: Signal,
    targetSymbol: string,
    isShortSymbol: boolean,
    monitorConfig: MonitorConfig | null = null,
  ): Promise<string | null> {
    if (!signal.symbol || typeof signal.symbol !== 'string') {
      logger.error(`[订单提交] 信号缺少有效的标的代码: ${JSON.stringify(signal)}`);
      return null;
    }

    const side = resolveOrderSide(signal.action);
    if (!side) {
      logger.error(`[订单提交] 未知的信号类型: ${signal.action}, 标的: ${signal.symbol}`);
      return null;
    }

    if (!canExecuteSignal(signal, 'submitTargetOrder')) {
      return null;
    }

    const targetNotional = monitorConfig?.targetNotional ?? TRADING.DEFAULT_TARGET_NOTIONAL;
    const orderType = resolveOrderType(signal);
    const timeInForce = TimeInForceType.Day;
    const remark = 'QuantDemo';

    if (side === OrderSide.Sell) {
      const submittedQtyDecimal = await quantityResolver.calculateSellQuantity(
        ctx,
        targetSymbol,
        signal,
      );
      if (submittedQtyDecimal.isZero()) {
        return null;
      }

      const submittedQtyNumber = decimalToNumber(submittedQtyDecimal);
      if (!isValidPositiveNumber(submittedQtyNumber)) {
        logger.warn(
          `[跳过订单] 卖出数量无效，无法合并卖单: ${submittedQtyDecimal.toString()}, symbol=${targetSymbol}`,
        );
        return null;
      }

      const resolvedPrice = isValidPositiveNumber(signal.price) ? signal.price : null;
      const pendingSellOrders = orderMonitor.getPendingSellOrders(targetSymbol);
      const decision = resolveSellMergeDecision({
        symbol: targetSymbol,
        pendingOrders: pendingSellOrders,
        newOrderQuantity: submittedQtyNumber,
        newOrderPrice: resolvedPrice,
        newOrderType: orderType,
        isProtectiveLiquidation: isLiquidationSignal(signal),
      });

      if (decision.action === 'REPLACE' && decision.targetOrderId) {
        if (!canExecuteSignal(signal, 'replaceOrderPrice')) {
          return null;
        }
        const price = decision.price ?? resolvedPrice ?? 0;
        if (!isValidPositiveNumber(price)) {
          logger.warn(`[订单合并] 无法获取有效改单价格，跳过: ${targetSymbol}`);
          return null;
        }
        await orderMonitor.replaceOrderPrice(
          decision.targetOrderId,
          price,
          decision.mergedQuantity,
        );
        return null;
      }

      if (decision.action === 'CANCEL_AND_SUBMIT') {
        if (!canExecuteSignal(signal, 'cancelAndSubmit')) {
          return null;
        }
        const cancelResults = await Promise.all(
          decision.pendingOrderIds.map((orderId) => orderMonitor.cancelOrder(orderId)),
        );
        if (cancelResults.some((ok) => !ok)) {
          const remaining = orderMonitor.getPendingSellOrders(targetSymbol);
          if (remaining.length > 0) {
            logger.warn(`[订单合并] 撤单失败且仍有未成交卖单，跳过合并提交: ${targetSymbol}`);
            return null;
          }
        }
      }

      if (decision.action === 'SKIP') {
        logger.info(`[订单合并] 无需新增卖单: ${targetSymbol}, reason=${decision.reason}`);
        return null;
      }

      if (decision.action === 'SUBMIT' || decision.action === 'CANCEL_AND_SUBMIT') {
        const mergedQtyDecimal = toDecimal(decision.mergedQuantity);
        return submitOrder({
          ctx,
          signal,
          symbol: targetSymbol,
          side,
          submittedQtyDecimal: mergedQtyDecimal,
          orderTypeParam: orderType,
          timeInForce,
          remark,
          overridePrice: decision.price ?? undefined,
          isShortSymbol,
          monitorConfig,
        });
      }
      return null;
    }

    const submittedQtyDecimal = quantityResolver.resolveBuyQuantity(
      signal,
      isShortSymbol,
      targetNotional,
    );

    if (submittedQtyDecimal.isZero()) {
      return null;
    }

    return submitOrder({
      ctx,
      signal,
      symbol: targetSymbol,
      side,
      submittedQtyDecimal,
      orderTypeParam: orderType,
      timeInForce,
      remark,
      overridePrice: undefined,
      isShortSymbol,
      monitorConfig,
    });
  };
}

/**
 * 订单监控模块（WebSocket 推送）
 *
 * 职责：
 * - WebSocket 订阅订单状态变化，实时响应成交/撤销/拒绝
 * - 价格跟踪：委托价跟随最新市价，确保订单能够成交
 * - 成交后更新：使用实际成交价更新本地订单记录
 * - 程序重启恢复：自动恢复追踪未完成订单
 *
 * 超时策略：
 * - 买入超时：仅撤销订单（避免追高）
 * - 卖出超时：撤销后转市价单（确保平仓）
 */

import {
  OrderStatus,
  OrderSide,
  OrderType,
  TimeInForceType,
  TopicType,
} from 'longport';
import type { PushOrderChanged } from 'longport';
import { logger } from '../../utils/logger/index.js';
import { decimalToNumber, toDecimal, formatError, toBeijingTimeIso } from '../../utils/helpers/index.js';
import { ORDER_PRICE_DIFF_THRESHOLD } from '../../constants/index.js';
import type { Quote, PendingRefreshSymbol, GlobalConfig } from '../../types/index.js';
import type {
  OrderMonitor,
  OrderMonitorDeps,
  TrackedOrder,
  OrderMonitorConfig,
} from './types.js';
import { recordTrade } from './tradeLogger.js';

/** 构建监控配置（将秒转换为毫秒） */
function buildOrderMonitorConfig(globalConfig: GlobalConfig): OrderMonitorConfig {
  return {
    buyTimeout: {
      enabled: globalConfig.buyOrderTimeout.enabled,
      timeoutMs: globalConfig.buyOrderTimeout.timeoutSeconds * 1000,
    },
    sellTimeout: {
      enabled: globalConfig.sellOrderTimeout.enabled,
      timeoutMs: globalConfig.sellOrderTimeout.timeoutSeconds * 1000,
    },
    priceUpdateIntervalMs: globalConfig.orderMonitorPriceUpdateInterval * 1000,
    priceDiffThreshold: ORDER_PRICE_DIFF_THRESHOLD, // 固定值，不需要配置
  };
}

/** 解析订单更新时间为毫秒时间戳 */
function resolveUpdatedAtMs(updatedAt: unknown): number | null {
  const ms =
    updatedAt instanceof Date
      ? updatedAt.getTime()
      : typeof updatedAt === 'number'
        ? updatedAt
        : typeof updatedAt === 'string' && updatedAt.trim()
          ? Date.parse(updatedAt)
          : Number.NaN;

  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * 创建订单监控器（依赖注入 OrderRecorder）
 * @param deps 依赖注入
 * @returns OrderMonitor 接口实例
 */
export function createOrderMonitor(deps: OrderMonitorDeps): OrderMonitor {
  const {
    ctxPromise,
    rateLimiter,
    cacheManager,
    orderRecorder,
    orderHoldRegistry,
    liquidationCooldownTracker,
    testHooks,
    tradingConfig,
    symbolRegistry,
  } = deps;
  const config = buildOrderMonitorConfig(tradingConfig.global);

  // 追踪中的订单
  const trackedOrders = new Map<string, TrackedOrder>();

  // 待刷新浮亏数据的标的列表（订单成交后添加，主循环中处理后清空）
  const pendingRefreshSymbols: PendingRefreshSymbol[] = [];

  function resolveSeatOwnership(
    symbol: string,
  ): { isLongSymbol: boolean; monitorSymbol: string | null } {
    const resolved = symbolRegistry.resolveSeatBySymbol(symbol);
    if (resolved) {
      return {
        isLongSymbol: resolved.direction === 'LONG',
        monitorSymbol: resolved.monitorSymbol,
      };
    }
    logger.warn(`[订单监控] 未找到席位归属，使用默认方向: ${symbol}`);
    return { isLongSymbol: true, monitorSymbol: null };
  }

  function resolveSignalAction(
    side: OrderSide,
    isLongSymbol: boolean,
  ): 'BUYCALL' | 'BUYPUT' | 'SELLCALL' | 'SELLPUT' {
    if (side === OrderSide.Buy) {
      return isLongSymbol ? 'BUYCALL' : 'BUYPUT';
    }
    return isLongSymbol ? 'SELLCALL' : 'SELLPUT';
  }

  /**
   * 处理 WebSocket 订单状态变化
   * 完全成交时用成交价更新本地记录，部分成交时继续追踪
   */
  function handleOrderChanged(event: PushOrderChanged): void {
    const orderId = event.orderId;
    const trackedOrder = trackedOrders.get(orderId);

    if (!trackedOrder) {
      // 不是我们追踪的订单，忽略
      return;
    }

    // 更新订单状态
    trackedOrder.status = event.status;
    // PushOrderChanged 的 executedQuantity / executedPrice 在 SDK 中通常为 Decimal
    // 必须使用 decimalToNumber() 进行安全转换，避免 Number(Decimal) -> NaN
    const executedQuantity = decimalToNumber(event.executedQuantity);
    trackedOrder.executedQuantity = executedQuantity || 0;

    // ========== 订单完全成交：使用成交价更新本地记录 ==========
    if (event.status === OrderStatus.Filled) {
      orderHoldRegistry.markOrderFilled(String(orderId));
      const executedPrice = decimalToNumber(event.executedPrice);
      const filledQuantity = decimalToNumber(event.executedQuantity);

      if (
        Number.isFinite(executedPrice) && executedPrice > 0 &&
        Number.isFinite(filledQuantity) && filledQuantity > 0
      ) {
        const executedTimeMs = resolveUpdatedAtMs(event.updatedAt);
        if (executedTimeMs == null) {
          logger.error(
            `[订单监控] 订单 ${orderId} 成交时间缺失，无法更新订单记录`,
          );
          trackedOrders.delete(orderId);
          return;
        }

        // 直接调用 orderRecorder 更新本地记录（无回调，无闭包）
        if (trackedOrder.side === OrderSide.Buy) {
          orderRecorder.recordLocalBuy(
            trackedOrder.symbol,
            executedPrice,
            filledQuantity,
            trackedOrder.isLongSymbol,
            executedTimeMs,
          );
        } else {
          orderRecorder.recordLocalSell(
            trackedOrder.symbol,
            executedPrice,
            filledQuantity,
            trackedOrder.isLongSymbol,
            executedTimeMs,
            String(orderId),
          );
        }

        if (trackedOrder.isProtectiveLiquidation) {
          const direction = trackedOrder.isLongSymbol ? 'LONG' : 'SHORT';
          if (trackedOrder.monitorSymbol) {
            liquidationCooldownTracker.recordCooldown({
              symbol: trackedOrder.monitorSymbol,
              direction,
              executedTimeMs,
            });
          } else {
            logger.error(
              `[订单监控] 订单 ${orderId} 缺少监控标的代码，无法记录清仓冷却`,
            );
          }
        }

        const signalAction = resolveSignalAction(
          trackedOrder.side,
          trackedOrder.isLongSymbol,
        );
        const executedAt = toBeijingTimeIso(new Date(executedTimeMs));

        recordTrade({
          orderId: String(orderId),
          symbol: trackedOrder.symbol,
          symbolName: null,
          monitorSymbol: trackedOrder.monitorSymbol,
          action: signalAction,
          side: trackedOrder.side === OrderSide.Buy ? 'BUY' : 'SELL',
          quantity: String(filledQuantity),
          price: String(executedPrice),
          orderType: null,
          status: 'FILLED',
          error: null,
          reason: null,
          signalTriggerTime: null,
          executedAt,
          executedAtMs: executedTimeMs,
          timestamp: null,
          isProtectiveClearance: trackedOrder.isProtectiveLiquidation,
        });

        logger.info(
          `[订单监控] 订单 ${orderId} 完全成交，` +
          `成交价=${executedPrice.toFixed(3)}，成交数量=${filledQuantity}，` +
          '已更新本地订单记录',
        );

        // 记录需要刷新的数据（订单成交后资金和持仓都会变化）
        // 主循环中会统一刷新账户、持仓和浮亏数据
        pendingRefreshSymbols.push({
          symbol: trackedOrder.symbol,
          isLongSymbol: trackedOrder.isLongSymbol,
          refreshAccount: true,
          refreshPositions: true,
        });
      } else {
        logger.warn(
          `[订单监控] 订单 ${orderId} 成交数据无效，` +
          `executedPrice=${event.executedPrice}，executedQuantity=${event.executedQuantity}`,
        );
      }

      // 移除追踪
      trackedOrders.delete(orderId);
      return;
    }

    // ========== 订单撤销或拒绝 ==========
    if (
      event.status === OrderStatus.Canceled ||
      event.status === OrderStatus.Rejected
    ) {
      trackedOrders.delete(orderId);
      logger.info(`[订单监控] 订单 ${orderId} 状态变为 ${event.status}，停止追踪`);
      return;
    }

    // ========== 部分成交：继续追踪，不更新本地记录 ==========
    if (event.status === OrderStatus.PartialFilled) {
      logger.info(
        `[订单监控] 订单 ${orderId} 部分成交，` +
        `已成交=${trackedOrder.executedQuantity}/${trackedOrder.submittedQuantity}，` +
        '等待完全成交后更新本地记录',
      );
    }
  }

  testHooks?.setHandleOrderChanged?.(handleOrderChanged);

  /** 初始化 WebSocket 订阅（订阅 Private 主题） */
  async function initialize(): Promise<void> {
    const ctx = await ctxPromise;

    // 设置订单变化回调（回调签名包含 err 和 event 两个参数）
    ctx.setOnOrderChanged((err: Error | null, event: PushOrderChanged) => {
      if (err) {
        logger.error('[订单监控] WebSocket 推送错误:', err.message);
        return;
      }
      handleOrderChanged(event);
    });

    // 订阅私有通知
    await ctx.subscribe([TopicType.Private]);

    logger.info('[订单监控] WebSocket 订阅初始化成功');
  }

  /** 开始追踪订单（订单提交后调用） */
  function trackOrder(
    orderId: string,
    symbol: string,
    side: OrderSide,
    price: number,
    quantity: number,
    isLongSymbol: boolean,
    monitorSymbol: string | null,
    isProtectiveLiquidation: boolean,
  ): void {
    const now = Date.now();

    orderHoldRegistry.trackOrder(String(orderId), symbol);

    const order: TrackedOrder = {
      orderId,
      symbol,
      side,
      isLongSymbol,
      monitorSymbol,
      isProtectiveLiquidation,
      submittedPrice: price,
      submittedQuantity: quantity,
      executedQuantity: 0,
      status: OrderStatus.New,
      submittedAt: now,
      lastPriceUpdateAt: now,
      convertedToMarket: false,
    };

    trackedOrders.set(orderId, order);

    logger.info(
      `[订单监控] 开始追踪订单 ${orderId}，` +
      `标的=${symbol}，方向=${side === OrderSide.Buy ? '买入' : '卖出'}，` +
      `${isLongSymbol ? '做多' : '做空'}标的`,
    );
  }

  /** 程序重启时恢复未完成订单的追踪 */
  async function recoverTrackedOrders(): Promise<void> {
    const ctx = await ctxPromise;

    await rateLimiter.throttle();
    const todayOrders = await ctx.todayOrders();

    let recoveredCount = 0;

    for (const order of todayOrders) {
      // 跳过已完成的订单
      if (
        order.status === OrderStatus.Filled ||
        order.status === OrderStatus.Canceled ||
        order.status === OrderStatus.Rejected
      ) {
        continue;
      }

      const symbol = order.symbol;
      const { isLongSymbol, monitorSymbol } = resolveSeatOwnership(symbol);

      // 获取已成交数量（用于部分成交订单的正确恢复）
      const executedQuantity = decimalToNumber(order.executedQuantity);

      // 重新追踪未完成的订单
      trackOrder(
        order.orderId,
        symbol,
        order.side,
        decimalToNumber(order.price),
        decimalToNumber(order.quantity),
        isLongSymbol,
        monitorSymbol,
        false,
      );

      // 修复：恢复部分成交订单的已成交数量
      // trackOrder 内部会将 executedQuantity 设为 0，这里需要更新为实际已成交数量
      const trackedOrder = trackedOrders.get(order.orderId);
      if (trackedOrder && executedQuantity > 0) {
        trackedOrder.executedQuantity = executedQuantity;
        logger.debug(
          `[订单监控] 恢复部分成交订单 ${order.orderId}，已成交数量=${executedQuantity}`,
        );
      }

      recoveredCount++;
    }

    if (recoveredCount > 0) {
      logger.info(`[订单监控] 程序启动恢复追踪 ${recoveredCount} 个未完成订单`);
    }
  }

  /** 撤销订单 */
  async function cancelOrder(orderId: string): Promise<boolean> {
    const ctx = await ctxPromise;

    try {
      await rateLimiter.throttle();
      await ctx.cancelOrder(orderId);

      cacheManager.clearCache();
      trackedOrders.delete(orderId);

      logger.info(`[订单撤销成功] 订单ID=${orderId}`);
      return true;
    } catch (err) {
      logger.error(
        `[订单撤销失败] 订单ID=${orderId}`,
        formatError(err),
      );
      return false;
    }
  }

  /** 修改订单委托价格 */
  async function replaceOrderPrice(
    orderId: string,
    newPrice: number,
    quantity: number | null = null,
  ): Promise<void> {
    const ctx = await ctxPromise;
    const trackedOrder = trackedOrders.get(orderId);

    if (!trackedOrder) {
      logger.warn(`[订单修改] 订单 ${orderId} 未在追踪列表中`);
      return;
    }

    // 计算剩余数量
    const remainingQty = trackedOrder.submittedQuantity - trackedOrder.executedQuantity;
    const targetQuantity = quantity ?? remainingQty;

    if (!Number.isFinite(targetQuantity) || targetQuantity <= 0) {
      logger.warn(`[订单修改] 订单 ${orderId} 剩余数量无效: ${targetQuantity}`);
      return;
    }

    const replacePayload = {
      orderId,
      price: toDecimal(newPrice),
      quantity: toDecimal(targetQuantity),
    };

    try {
      await rateLimiter.throttle();
      await ctx.replaceOrder(replacePayload);

      cacheManager.clearCache();

      logger.info(
        `[订单修改成功] 订单ID=${orderId} 新价格=${newPrice.toFixed(3)}`,
      );
    } catch (err) {
      const errorMessage = formatError(err);
      logger.error(
        `[订单修改失败] 订单ID=${orderId} 新价格=${newPrice.toFixed(3)}`,
        errorMessage,
      );
      throw new Error(`订单修改失败: ${errorMessage}`);
    }
  }

  /** 处理买入订单超时：仅撤销（避免追高） */
  async function handleBuyOrderTimeout(orderId: string, order: TrackedOrder): Promise<void> {
    const elapsed = Date.now() - order.submittedAt;

    logger.warn(
      `[订单监控] 买入订单 ${orderId} 超时(${Math.floor(elapsed / 1000)}秒)，撤销订单`,
    );

    // 计算剩余数量
    const remainingQuantity = order.submittedQuantity - order.executedQuantity;
    if (remainingQuantity <= 0) {
      // 已经全部成交，移除追踪
      trackedOrders.delete(orderId);
      return;
    }

    // 撤销订单
    const cancelled = await cancelOrder(orderId);

    if (cancelled) {
      logger.info(
        `[订单监控] 买入订单 ${orderId} 已撤销，剩余未成交数量=${remainingQuantity}`,
      );
    } else {
      logger.warn(
        `[订单监控] 买入订单 ${orderId} 撤销失败（可能已成交或已撤销）`,
      );
    }
  }

  /** 处理卖出订单超时：撤销后转市价单（确保平仓） */
  async function handleSellOrderTimeout(orderId: string, order: TrackedOrder): Promise<void> {
    const elapsed = Date.now() - order.submittedAt;

    logger.warn(
      `[订单监控] 卖出订单 ${orderId} 超时(${Math.floor(elapsed / 1000)}秒)，转换为市价单`,
    );

    // 计算剩余数量
    const remainingQuantity = order.submittedQuantity - order.executedQuantity;
    if (remainingQuantity <= 0) {
      // 已经全部成交，移除追踪
      trackedOrders.delete(orderId);
      return;
    }

    try {
      // 1. 撤销原订单
      const cancelled = await cancelOrder(orderId);

      // 如果撤销失败（订单可能已成交或已撤销），不继续提交市价单
      // 避免重复下单导致持仓数据错误
      if (!cancelled) {
        logger.warn(
          `[订单监控] 卖出订单 ${orderId} 撤销失败（可能已成交或已撤销），跳过市价单提交`,
        );
        return;
      }

      // 2. 撤销成功后，使用市价单重新提交
      const ctx = await ctxPromise;
      const marketOrderPayload = {
        symbol: order.symbol,
        side: order.side,
        orderType: OrderType.MO,
        submittedQuantity: toDecimal(remainingQuantity),
        timeInForce: TimeInForceType.Day,
        remark: `超时转市价-原订单${orderId}`,
      };

      await rateLimiter.throttle();
      const resp = await ctx.submitOrder(marketOrderPayload);

      const newOrderId = (resp as { orderId?: string })?.orderId ?? 'UNKNOWN';

      logger.info(
        `[订单监控] 卖出订单 ${orderId} 已转为市价单，新订单ID=${newOrderId}，数量=${remainingQuantity}`,
      );

      // 追踪新的市价单（市价单通常很快成交，但仍需追踪）
      // 继承原订单的 isLongSymbol，确保成交后能正确更新本地记录
      trackOrder(
        String(newOrderId),
        order.symbol,
        order.side,
        0,                    // 市价单无价格
        remainingQuantity,
        order.isLongSymbol,   // 继承原订单的做多/做空标识
        order.monitorSymbol,
        order.isProtectiveLiquidation,
      );

      // 标记新订单已转换为市价单（避免再次转换）
      const newTrackedOrder = trackedOrders.get(String(newOrderId));
      if (newTrackedOrder) {
        newTrackedOrder.convertedToMarket = true;
      }

    } catch (err) {
      logger.error(`[订单监控] 卖出订单 ${orderId} 转市价单失败:`, err);
    }
  }

  /**
   * 根据最新行情更新委托价（主循环每秒调用）
   * 委托价跟随市价变化，确保订单能够成交
   */
  async function processWithLatestQuotes(
    quotesMap: ReadonlyMap<string, Quote | null>,
  ): Promise<void> {
    const now = Date.now();

    for (const [orderId, order] of trackedOrders) {
      // 跳过已转为市价单的订单
      if (order.convertedToMarket) {
        continue;
      }

      // 根据订单方向检查超时
      const isBuyOrder = order.side === OrderSide.Buy;
      const timeoutConfig = isBuyOrder ? config.buyTimeout : config.sellTimeout;

      if (timeoutConfig.enabled) {
        const elapsed = now - order.submittedAt;
        if (elapsed >= timeoutConfig.timeoutMs) {
          if (isBuyOrder) {
            await handleBuyOrderTimeout(orderId, order);
          } else {
            await handleSellOrderTimeout(orderId, order);
          }
          continue;
        }
      }

      // 检查是否在修改间隔内
      if (now - order.lastPriceUpdateAt < config.priceUpdateIntervalMs) {
        continue;
      }

      // 获取最新行情
      const quote = quotesMap.get(order.symbol);
      if (!quote || !Number.isFinite(quote.price)) {
        continue;
      }

      const currentPrice = quote.price;
      const priceDiff = Math.abs(currentPrice - order.submittedPrice);

      // 价格差异小于阈值，不修改
      if (priceDiff < config.priceDiffThreshold) {
        continue;
      }

      // 更新委托价
      const sideDesc = isBuyOrder ? '买入' : '卖出';
      const priceDirection = currentPrice > order.submittedPrice ? '上涨' : '下跌';

      logger.info(
        `[订单监控] ${sideDesc}订单 ${orderId} 当前价(${currentPrice.toFixed(3)}) ` +
        `${priceDirection}，更新委托价：${order.submittedPrice.toFixed(3)} → ${currentPrice.toFixed(3)}`,
      );

      try {
        await replaceOrderPrice(orderId, currentPrice);
        order.submittedPrice = currentPrice;
        order.lastPriceUpdateAt = now;
      } catch (err) {
        logger.error(`[订单监控] 修改订单 ${orderId} 价格失败:`, err);
      }
    }
  }

  /** 获取并清空待刷新标的列表（订单成交后需刷新持仓和浮亏） */
  function getAndClearPendingRefreshSymbols(): PendingRefreshSymbol[] {
    if (pendingRefreshSymbols.length === 0) {
      return [];
    }

    return pendingRefreshSymbols.splice(0);
  }

  /** 销毁监控器（清理追踪列表） */
  async function destroy(): Promise<void> {
    trackedOrders.clear();
    pendingRefreshSymbols.length = 0;
    logger.info('[订单监控] 监控器已销毁');
  }

  return {
    initialize,
    trackOrder,
    cancelOrder,
    replaceOrderPrice,
    processWithLatestQuotes,
    recoverTrackedOrders,
    getAndClearPendingRefreshSymbols,
    destroy,
  };
}

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
  type PushOrderChanged,
} from 'longport';
import { logger } from '../../utils/logger/index.js';
import {
  decimalToNumber,
  toDecimal,
  formatError,
  toHongKongTimeIso,
  isValidPositiveNumber,
} from '../../utils/helpers/index.js';
import {
  NON_REPLACEABLE_ORDER_STATUSES,
  NON_REPLACEABLE_ORDER_TYPES,
  ORDER_PRICE_DIFF_THRESHOLD,
  PENDING_ORDER_STATUSES,
} from '../../constants/index.js';
import type { Quote } from '../../types/quote.js';
import type { GlobalConfig } from '../../types/config.js';
import type { PendingRefreshSymbol } from '../../types/services.js';
import type {
  OrderMonitor,
  OrderMonitorDeps,
  TrackedOrder,
  OrderMonitorConfig,
  PendingSellOrderSnapshot,
  TrackOrderParams,
} from './types.js';
import { recordTrade } from './tradeLogger.js';

/**
 * 根据订单方向和席位方向解析信号动作（用于成交日志与本地记录）
 * @param side 订单方向 Buy/Sell
 * @param isLongSymbol 是否为做多标的（牛证/做多）
 * @returns 对应的信号动作 BUYCALL | BUYPUT | SELLCALL | SELLPUT
 */
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
 * 构建订单监控配置（将全局配置中的秒转换为毫秒，供超时与价格更新间隔使用）
 * @param globalConfig 全局配置，含买入/卖出超时秒数及价格更新间隔
 * @returns 订单监控所需配置（超时与间隔均为毫秒）
 */
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

/**
 * 解析订单更新时间为毫秒时间戳（兼容 Date、number、ISO 字符串）
 * @param updatedAt SDK 推送或 API 返回的 updatedAt 字段
 * @returns 毫秒时间戳，无法解析时返回 null
 */
function resolveUpdatedAtMs(updatedAt: unknown): number | null {
  if (updatedAt instanceof Date) {
    return updatedAt.getTime();
  }
  if (typeof updatedAt === 'number') {
    return updatedAt;
  }
  if (typeof updatedAt === 'string' && updatedAt.trim()) {
    const parsed = Date.parse(updatedAt);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

/**
 * 创建订单监控器。
 * 订阅 WebSocket 订单推送、维护追踪订单列表、委托价跟随市价更新、超时转市价/撤单，成交后更新本地订单记录与浮亏刷新列表。
 * 订单状态与价格需实时响应，与 orderRecorder、dailyLossTracker、liquidationCooldownTracker 联动，统一在此处处理推送与副作用。
 * @param deps 依赖（ctxPromise、rateLimiter、cacheManager、orderRecorder、dailyLossTracker、orderHoldRegistry、tradingConfig 等）
 * @returns 实现 OrderMonitor 接口的实例（trackOrder、processWithLatestQuotes、cancelOrder、replaceOrderPrice 等）
 */
export function createOrderMonitor(deps: OrderMonitorDeps): OrderMonitor {
  const {
    ctxPromise,
    rateLimiter,
    cacheManager,
    orderRecorder,
    dailyLossTracker,
    orderHoldRegistry,
    liquidationCooldownTracker,
    testHooks,
    tradingConfig,
    symbolRegistry,
    refreshGate,
    isExecutionAllowed,
  } = deps;
  const config = buildOrderMonitorConfig(tradingConfig.global);

  // 追踪中的订单
  const trackedOrders = new Map<string, TrackedOrder>();

  // 待刷新浮亏数据的标的列表（订单成交后添加，主循环中处理后清空）
  const pendingRefreshSymbols: PendingRefreshSymbol[] = [];

  /** 通过标的代码解析席位归属（做多/做空方向及监控标的），未找到时使用默认值并记录警告 */
  function resolveSeatOwnership(symbol: string): {
    isLongSymbol: boolean;
    monitorSymbol: string | null;
  } {
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

      if (isValidPositiveNumber(executedPrice) && isValidPositiveNumber(filledQuantity)) {
        const executedTimeMs = resolveUpdatedAtMs(event.updatedAt);
        if (executedTimeMs === null || executedTimeMs === undefined) {
          logger.error(`[订单监控] 订单 ${orderId} 成交时间缺失，无法更新订单记录`);
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
          // 更新待成交追踪
          orderRecorder.markSellFilled(String(orderId));
        }

        if (trackedOrder.monitorSymbol) {
          dailyLossTracker.recordFilledOrder({
            monitorSymbol: trackedOrder.monitorSymbol,
            symbol: trackedOrder.symbol,
            isLongSymbol: trackedOrder.isLongSymbol,
            side: trackedOrder.side,
            executedPrice,
            executedQuantity: filledQuantity,
            executedTimeMs,
            orderId: String(orderId),
          });
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
            logger.error(`[订单监控] 订单 ${orderId} 缺少监控标的代码，无法记录清仓冷却`);
          }
        }

        const signalAction = resolveSignalAction(trackedOrder.side, trackedOrder.isLongSymbol);
        const executedAt = toHongKongTimeIso(new Date(executedTimeMs));

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
        refreshGate?.markStale();
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

    // 订单撤销或拒绝
    if (event.status === OrderStatus.Canceled || event.status === OrderStatus.Rejected) {
      // 订单取消时释放追踪
      if (trackedOrder.side === OrderSide.Sell) {
        orderRecorder.markSellCancelled(String(orderId));
      }
      trackedOrders.delete(orderId);
      logger.info(`[订单监控] 订单 ${orderId} 状态变为 ${event.status}，停止追踪`);
      return;
    }

    // 部分成交：继续追踪，不更新本地记录
    if (event.status === OrderStatus.PartialFilled) {
      // 更新待成交追踪
      if (trackedOrder.side === OrderSide.Sell) {
        orderRecorder.markSellPartialFilled(String(orderId), executedQuantity);
      }
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
  function trackOrder(params: TrackOrderParams): void {
    const {
      orderId,
      symbol,
      side,
      price,
      quantity,
      isLongSymbol,
      monitorSymbol,
      isProtectiveLiquidation,
      orderType,
    } = params;
    const now = Date.now();

    orderHoldRegistry.trackOrder(String(orderId), symbol);

    const order: TrackedOrder = {
      orderId,
      symbol,
      side,
      isLongSymbol,
      monitorSymbol,
      isProtectiveLiquidation,
      orderType,
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
      const submittedQuantity = decimalToNumber(order.quantity);

      // 重新追踪未完成的订单
      trackOrder({
        orderId: order.orderId,
        symbol,
        side: order.side,
        price: decimalToNumber(order.price),
        quantity: submittedQuantity,
        isLongSymbol,
        monitorSymbol,
        isProtectiveLiquidation: false,
        orderType: order.orderType,
      });

      // trackOrder 内部会将 executedQuantity 设为 0，这里需要更新为实际已成交数量
      const trackedOrder = trackedOrders.get(order.orderId);
      if (trackedOrder && executedQuantity > 0) {
        trackedOrder.executedQuantity = executedQuantity;
        logger.debug(
          `[订单监控] 恢复部分成交订单 ${order.orderId}，已成交数量=${executedQuantity}`,
        );
      }

      // 恢复期：未完成卖单同步恢复 pendingSells，避免跨日后 getProfitableSellOrders 重复分配
      if (order.side === OrderSide.Sell && submittedQuantity > 0) {
        const direction = isLongSymbol ? 'LONG' : 'SHORT';
        const relatedBuyOrderIds = orderRecorder.allocateRelatedBuyOrderIdsForRecovery(
          symbol,
          direction,
          submittedQuantity,
        );
        orderRecorder.submitSellOrder(
          order.orderId,
          symbol,
          direction,
          submittedQuantity,
          relatedBuyOrderIds,
        );
        if (executedQuantity > 0) {
          orderRecorder.markSellPartialFilled(order.orderId, executedQuantity);
        }
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
      logger.error(`[订单撤销失败] 订单ID=${orderId}`, formatError(err));
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
      trackedOrder.submittedPrice = newPrice;
      trackedOrder.submittedQuantity = trackedOrder.executedQuantity + targetQuantity;
      trackedOrder.lastPriceUpdateAt = Date.now();

      logger.info(`[订单修改成功] 订单ID=${orderId} 新价格=${newPrice.toFixed(3)}`);
    } catch (err) {
      const errorMessage = formatError(err);
      logger.error(`[订单修改失败] 订单ID=${orderId} 新价格=${newPrice.toFixed(3)}`, errorMessage);
      throw new Error(`订单修改失败: ${errorMessage}`, { cause: err });
    }
  }

  /** 处理买入订单超时：仅撤销（避免追高） */
  async function handleBuyOrderTimeout(orderId: string, order: TrackedOrder): Promise<void> {
    const elapsed = Date.now() - order.submittedAt;

    logger.warn(`[订单监控] 买入订单 ${orderId} 超时(${Math.floor(elapsed / 1000)}秒)，撤销订单`);

    // 计算剩余数量
    const remainingQuantity = order.submittedQuantity - order.executedQuantity;
    if (remainingQuantity <= 0) {
      // 已经全部成交，移除追踪
      trackedOrders.delete(orderId);
      return;
    }

    const cancelled = await cancelOrder(orderId);

    if (cancelled) {
      logger.info(`[订单监控] 买入订单 ${orderId} 已撤销，剩余未成交数量=${remainingQuantity}`);
    } else {
      logger.warn(`[订单监控] 买入订单 ${orderId} 撤销失败（可能已成交或已撤销）`);
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
      const cancelledPending = orderRecorder.markSellCancelled(orderId);

      // 门禁检查：禁止在门禁关闭时发起新开单（撤销已执行，仅阻止市价单提交）
      if (!isExecutionAllowed()) {
        logger.info(`[执行门禁] 门禁关闭，卖出订单 ${orderId} 超时转市价单被阻止，原订单已撤销`);
        return;
      }

      // 2. 撤销成功后，使用市价单重新提交
      const ctx = await ctxPromise;

      // 二次门禁检查（await 后状态可能变化）
      if (!isExecutionAllowed()) {
        logger.info(`[执行门禁] 门禁已关闭，卖出订单 ${orderId} 转市价单被阻止，原订单已撤销`);
        return;
      }

      const marketOrderPayload = {
        symbol: order.symbol,
        side: order.side,
        orderType: OrderType.MO,
        submittedQuantity: toDecimal(remainingQuantity),
        timeInForce: TimeInForceType.Day,
        remark: `超时转市价-原订单${orderId}`,
      };

      await rateLimiter.throttle();
      if (!isExecutionAllowed()) {
        logger.info(
          `[执行门禁] 门禁已关闭，卖出订单 ${orderId} 转市价单在提交前被阻止，原订单已撤销`,
        );
        return;
      }
      const resp = await ctx.submitOrder(marketOrderPayload);

      const newOrderId = (resp as { orderId?: string })?.orderId ?? 'UNKNOWN';
      const direction: 'LONG' | 'SHORT' = order.isLongSymbol ? 'LONG' : 'SHORT';
      const relatedBuyOrderIds =
        cancelledPending?.relatedBuyOrderIds ??
        orderRecorder.allocateRelatedBuyOrderIdsForRecovery(
          order.symbol,
          direction,
          remainingQuantity,
        );
      orderRecorder.submitSellOrder(
        String(newOrderId),
        order.symbol,
        direction,
        remainingQuantity,
        relatedBuyOrderIds,
      );

      logger.info(
        `[订单监控] 卖出订单 ${orderId} 已转为市价单，新订单ID=${newOrderId}，数量=${remainingQuantity}`,
      );

      // 追踪新的市价单（市价单通常很快成交，但仍需追踪）
      // 继承原订单的 isLongSymbol，确保成交后能正确更新本地记录
      trackOrder({
        orderId: String(newOrderId),
        symbol: order.symbol,
        side: order.side,
        price: 0, // 市价单无价格
        quantity: remainingQuantity,
        isLongSymbol: order.isLongSymbol, // 继承原订单的做多/做空标识
        monitorSymbol: order.monitorSymbol,
        isProtectiveLiquidation: order.isProtectiveLiquidation,
        orderType: OrderType.MO,
      });

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

      if (
        NON_REPLACEABLE_ORDER_TYPES.has(order.orderType) ||
        NON_REPLACEABLE_ORDER_STATUSES.has(order.status)
      ) {
        continue;
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
      } catch (err) {
        logger.error(`[订单监控] 修改订单 ${orderId} 价格失败:`, err);
      }
    }
  }

  /** 获取指定标的的未成交卖单快照 */
  function getPendingSellOrders(symbol: string): ReadonlyArray<PendingSellOrderSnapshot> {
    const pendingOrders: PendingSellOrderSnapshot[] = [];
    for (const order of trackedOrders.values()) {
      if (order.symbol !== symbol) {
        continue;
      }
      if (order.side !== OrderSide.Sell) {
        continue;
      }
      if (!PENDING_ORDER_STATUSES.has(order.status)) {
        continue;
      }
      const remaining = order.submittedQuantity - order.executedQuantity;
      if (!Number.isFinite(remaining) || remaining <= 0) {
        continue;
      }
      pendingOrders.push({
        orderId: order.orderId,
        symbol: order.symbol,
        side: order.side,
        status: order.status,
        orderType: order.orderType,
        submittedPrice: order.submittedPrice,
        submittedQuantity: order.submittedQuantity,
        executedQuantity: order.executedQuantity,
        submittedAt: order.submittedAt,
      });
    }
    return pendingOrders.sort((a, b) => a.submittedAt - b.submittedAt);
  }

  /** 获取并清空待刷新标的列表（订单成交后需刷新持仓和浮亏） */
  function getAndClearPendingRefreshSymbols(): PendingRefreshSymbol[] {
    if (pendingRefreshSymbols.length === 0) {
      return [];
    }

    return pendingRefreshSymbols.splice(0);
  }

  /** 清空 trackedOrders 与 pendingRefreshSymbols */
  function clearTrackedOrders(): void {
    trackedOrders.clear();
    pendingRefreshSymbols.length = 0;
  }

  return {
    initialize,
    trackOrder,
    cancelOrder,
    replaceOrderPrice,
    processWithLatestQuotes,
    recoverTrackedOrders,
    getPendingSellOrders,
    getAndClearPendingRefreshSymbols,
    clearTrackedOrders,
  };
}

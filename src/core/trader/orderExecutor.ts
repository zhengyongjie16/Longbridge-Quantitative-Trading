/**
 * 订单执行模块
 *
 * 职责：
 * - 执行交易信号（BUYCALL/SELLCALL/BUYPUT/SELLPUT）
 * - 计算买入数量（按目标金额和每手股数）
 * - 计算卖出数量（查询实际可用持仓）
 * - 管理同方向买入频率限制（防止重复开仓）
 *
 * 订单类型：
 * - 普通交易使用 tradingOrderType（LO/ELO/MO）
 * - 保护性清仓使用 liquidationOrderType
 */
import { TradeContext, OrderSide, OrderType, TimeInForceType, Decimal } from 'longport';
import { logger } from '../../utils/logger/index.js';
import { LOG_COLORS, TIME, TRADING } from '../../constants/index.js';
import { getHKDateKey } from '../../utils/helpers/tradingTime.js';
import {
  decimalToNumber,
  toDecimal,
  formatError,
  isDefined,
  isValidPositiveNumber,
  formatSymbolDisplay,
  isBuyAction,
  isSellAction,
} from '../../utils/helpers/index.js';
import type { Signal, SignalType } from '../../types/signal.js';
import type { MonitorConfig } from '../../types/config.js';
import type { TradeCheckResult } from '../../types/services.js';
import type { OrderPayload, OrderExecutor, OrderExecutorDeps, SubmitOrderParams } from './types.js';
import { identifyErrorType } from './tradeLogger.js';
import {
  extractOrderId,
  formatOrderTypeLabel,
  getOrderTypeCode,
  resolveOrderTypeConfig,
  resolveSellMergeDecision,
} from './utils.js';

/** 操作描述映射 */
const ACTION_DESCRIPTION_MAP: Record<string, string> = {
  BUYCALL: '买入做多标的（做多）',
  SELLCALL: '卖出做多标的（平仓）',
  BUYPUT: '买入做空标的（做空）',
  SELLPUT: '卖出做空标的（平仓）',
  HOLD: '持有',
};

/** 获取操作描述（用于日志） */
function getActionDescription(signalAction: Signal['action']): string {
  return ACTION_DESCRIPTION_MAP[signalAction] ?? `未知操作(${signalAction})`;
}

/** 配置字符串转 OrderType 枚举 */
function getOrderTypeFromConfig(typeConfig: 'LO' | 'ELO' | 'MO'): OrderType {
  if (typeConfig === 'LO') {
    return OrderType.LO;
  }
  if (typeConfig === 'MO') {
    return OrderType.MO;
  }
  return OrderType.ELO;
}

/** 检查信号是否为跨日或触发时间无效的过期信号（保护性清仓信号不参与此校验） */
function isStaleCrossDaySignal(signal: Signal, now: Date): boolean {
  if (!(signal.triggerTime instanceof Date) || Number.isNaN(signal.triggerTime.getTime())) {
    return true;
  }
  return getHKDateKey(signal.triggerTime) !== getHKDateKey(now);
}

/** 计算买入数量（按目标金额和每手股数） */
function calculateBuyQuantity(
  signal: Signal,
  isShortSymbol: boolean,
  overridePrice: number | undefined,
  targetNotional: number,
): Decimal {
  const priceNum = Number(overridePrice ?? signal?.price ?? null);
  if (!Number.isFinite(priceNum) || priceNum <= 0) {
    logger.warn(`[跳过订单] 无法获取有效价格，无法按金额计算买入数量，price=${priceNum}`);
    return Decimal.ZERO();
  }

  const notional = isValidPositiveNumber(targetNotional)
    ? targetNotional
    : TRADING.DEFAULT_TARGET_NOTIONAL;

  let rawQty = Math.floor(notional / priceNum);

  // 获取最小买卖单位（已在配置验证阶段确保 lotSize 有效）
  const lotSize: number = signal?.lotSize ?? 0;
  if (!Number.isFinite(lotSize) || lotSize <= 0) {
    logger.error(`[跳过订单] lotSize 无效(${lotSize})，这不应该发生，请检查配置验证逻辑`);
    return Decimal.ZERO();
  }

  // 此时 lotSize 一定是有效的正数
  rawQty = Math.floor(rawQty / lotSize) * lotSize;
  if (!Number.isFinite(rawQty) || rawQty < lotSize) {
    logger.warn(
      `[跳过订单] 目标金额(${notional}) 相对于价格(${priceNum}) 太小，按每手 ${lotSize} 股计算得到数量=${rawQty}，跳过提交订单`,
    );
    return Decimal.ZERO();
  }

  const actionType = isShortSymbol ? '买入做空标的（做空）' : '买入做多标的（做多）';
  logger.info(
    `[仓位计算] 按目标金额 ${notional} 计算得到${actionType}数量=${rawQty} 股（${lotSize} 股一手），单价≈${priceNum}`,
  );

  return toDecimal(rawQty);
}

/** 判断是否为保护性清仓信号（末日保护、强制止损等） */
function isLiquidationSignal(signal: Signal): boolean {
  return signal.isProtectiveLiquidation === true;
}

/** 根据信号动作解析订单方向 */
function resolveOrderSide(action: Signal['action']): OrderSide | null {
  switch (action) {
    case 'BUYCALL':
    case 'BUYPUT':
      return OrderSide.Buy;
    case 'SELLCALL':
    case 'SELLPUT':
      return OrderSide.Sell;
    default:
      return null;
  }
}

/** 生成买入频率限制的时间键 */
function buildBuyTimeKey(signalAction: string, monitorConfig?: MonitorConfig | null): string {
  const direction: 'LONG' | 'SHORT' = signalAction === 'BUYCALL' ? 'LONG' : 'SHORT';
  const monitorSymbol = monitorConfig?.monitorSymbol ?? '';
  return monitorSymbol ? `${monitorSymbol}:${direction}` : direction;
}

/** 处理订单提交错误（分类记录日志） */
function handleSubmitError(err: unknown, signal: Signal, orderPayload: OrderPayload): void {
  const actionDesc = getActionDescription(signal.action);

  const errorMessage = formatError(err);
  const errorType = identifyErrorType(errorMessage);

  // 格式化标的显示（用于错误日志）
  const symbolDisplayForError = formatSymbolDisplay(orderPayload.symbol, signal.symbolName ?? null);

  // 根据错误类型进行针对性处理
  if (errorType.isShortSellingNotSupported) {
    logger.error(
      `[订单提交失败] ${actionDesc} ${symbolDisplayForError} 失败：该标的不支持做空交易`,
      errorMessage,
    );
    logger.warn(
      `[做空错误提示] 标的 ${symbolDisplayForError} 不支持做空交易。可能的原因：\n` +
        '  1. 该标的在港股市场不支持做空\n' +
        '  2. 账户没有做空权限\n' +
        '  3. 需要更换其他支持做空的标的\n' +
        '  建议：检查配置中的 SHORT_SYMBOL 环境变量，或联系券商确认账户做空权限',
    );
  } else if (errorType.isInsufficientFunds) {
    logger.error(
      `[订单提交失败] ${actionDesc} ${symbolDisplayForError} 失败：账户资金不足`,
      errorMessage,
    );
  } else if (errorType.isNetworkError) {
    logger.error(
      `[订单提交失败] ${actionDesc} ${symbolDisplayForError} 失败：网络异常，请检查连接`,
      errorMessage,
    );
  } else if (errorType.isRateLimited) {
    logger.error(
      `[订单提交失败] ${actionDesc} ${symbolDisplayForError} 失败：API 调用频率超限`,
      errorMessage,
    );
  } else {
    logger.error(`[订单提交失败] ${actionDesc} ${symbolDisplayForError} 失败：`, errorMessage);
  }
}

/**
 * 创建订单执行器（核心业务流程：信号执行与订单提交）
 * 负责将交易信号转为买卖订单、计算数量、调用 API 提交，并配合 orderMonitor 追踪与风控。
 * @param deps 依赖注入（ctxPromise、rateLimiter、cacheManager、orderMonitor、orderRecorder、tradingConfig、symbolRegistry、isExecutionAllowed）
 * @returns OrderExecutor 接口实例（canTradeNow、markBuyAttempt、executeSignals、resetBuyThrottle）
 */
export function createOrderExecutor(deps: OrderExecutorDeps): OrderExecutor {
  const {
    ctxPromise,
    rateLimiter,
    cacheManager,
    orderMonitor,
    orderRecorder,
    tradingConfig,
    symbolRegistry,
    isExecutionAllowed,
  } = deps;
  const { global, monitors } = tradingConfig;

  /** 通过信号标的解析监控配置与方向，未找到席位或配置时返回 null 并记录警告 */
  function resolveMonitorConfigBySymbol(
    signalSymbol: string,
  ): { monitorConfig: MonitorConfig; isShortSymbol: boolean } | null {
    const resolvedSeat = symbolRegistry.resolveSeatBySymbol(signalSymbol);
    if (!resolvedSeat) {
      logger.warn(`[订单执行] 未找到席位标的，跳过信号: ${signalSymbol}`);
      return null;
    }
    const monitorConfig = monitors.find(
      (config) => config.monitorSymbol === resolvedSeat.monitorSymbol,
    );
    if (!monitorConfig) {
      logger.warn(`[订单执行] 未找到监控配置，跳过信号: ${signalSymbol}`);
      return null;
    }
    return {
      monitorConfig,
      isShortSymbol: resolvedSeat.direction === 'SHORT',
    };
  }

  /** 检查执行门禁是否开放；门禁关闭时记录日志并返回 false，阻止后续下单 */
  function canExecuteSignal(signal: Signal, stage: string): boolean {
    if (isExecutionAllowed()) {
      return true;
    }
    logger.info(
      `[执行门禁] ${stage} 门禁关闭，跳过信号: ${formatSymbolDisplay(signal.symbol, signal.symbolName ?? null)} ${signal.action}`,
    );
    return false;
  }

  // 闭包捕获的私有状态
  // 记录每个监控标的的每个方向标的的最后买入时间
  // Key 格式: `${monitorSymbol}:${direction}` 例如 "700.HK:LONG"
  const lastBuyTime = new Map<string, number>();

  /**
   * 检查买入频率限制
   * 卖出无限制，买入需满足 buyIntervalSeconds 间隔
   */
  function canTradeNow(
    signalAction: SignalType,
    monitorConfig?: MonitorConfig | null,
  ): TradeCheckResult {
    // 卖出操作不触发频率限制
    if (isSellAction(signalAction)) {
      return { canTrade: true };
    }

    // 确定方向：BUYCALL 是 LONG，BUYPUT 是 SHORT
    const direction: 'LONG' | 'SHORT' = signalAction === 'BUYCALL' ? 'LONG' : 'SHORT';

    // 使用配置中的 buyIntervalSeconds，如果没有配置则使用默认值
    const buyIntervalSeconds = monitorConfig?.buyIntervalSeconds ?? 60;

    // 使用监控标的符号作为键的一部分，以支持多个监控标的
    const timeKey = buildBuyTimeKey(signalAction, monitorConfig);

    const lastTime = lastBuyTime.get(timeKey);

    if (!lastTime) {
      return { canTrade: true };
    }

    const now = Date.now();
    const timeDiff = now - lastTime;
    const intervalMs = buyIntervalSeconds * TIME.MILLISECONDS_PER_SECOND;

    if (timeDiff >= intervalMs) {
      return { canTrade: true };
    }

    const waitSeconds = Math.ceil((intervalMs - timeDiff) / TIME.MILLISECONDS_PER_SECOND);
    return {
      canTrade: false,
      waitSeconds,
      direction,
      reason: `需等待 ${waitSeconds} 秒`,
    };
  }

  /** 记录买入时间（用于频率限制） */
  function updateLastBuyTime(signalAction: SignalType, monitorConfig?: MonitorConfig | null): void {
    if (isBuyAction(signalAction)) {
      lastBuyTime.set(buildBuyTimeKey(signalAction, monitorConfig), Date.now());
    }
  }

  /** 清空 lastBuyTime（买入节流状态） */
  function resetBuyThrottle(): void {
    lastBuyTime.clear();
  }

  /**
   * 预占买入时间槽
   * 在频率检查通过后立即调用，防止同批次信号重复通过检查
   */
  function markBuyAttempt(signalAction: SignalType, monitorConfig?: MonitorConfig | null): void {
    updateLastBuyTime(signalAction, monitorConfig);
  }

  /** 解析订单类型（覆盖优先，其次保护性清仓） */
  function resolveOrderType(signal: Signal): OrderType {
    const orderTypeConfig = resolveOrderTypeConfig(signal, global);
    return getOrderTypeFromConfig(orderTypeConfig);
  }

  /** 计算卖出数量（查询实际可用持仓） */
  async function calculateSellQuantity(
    ctx: TradeContext,
    symbol: string,
    signal: Signal,
  ): Promise<Decimal> {
    let targetQuantity: number | null = null;
    if (isDefined(signal.quantity)) {
      const signalQty = Number(signal.quantity);
      if (isValidPositiveNumber(signalQty)) {
        targetQuantity = signalQty;
      }
    }

    await rateLimiter.throttle();
    const resp = await ctx.stockPositions([symbol]);
    const channels = resp?.channels ?? [];
    let totalAvailable = 0;
    for (const ch of channels) {
      const positions = Array.isArray(ch.positions) ? ch.positions : [];
      for (const pos of positions) {
        if (pos?.symbol === symbol && pos.availableQuantity) {
          const qty = decimalToNumber(pos.availableQuantity);
          if (isValidPositiveNumber(qty)) {
            totalAvailable += qty;
          }
        }
      }
    }

    if (!Number.isFinite(totalAvailable) || totalAvailable <= 0) {
      logger.warn(
        `[跳过订单] 当前无可用持仓，无需平仓。symbol=${symbol}, available=${totalAvailable}`,
      );
      return Decimal.ZERO();
    }

    if (targetQuantity == null) {
      return toDecimal(totalAvailable);
    }
    const actualQty = Math.min(targetQuantity, totalAvailable);
    logger.info(
      `[部分卖出] 信号指定卖出数量=${targetQuantity}，可用数量=${totalAvailable}，实际卖出=${actualQty}`,
    );
    return toDecimal(actualQty);
  }

  /** 提交订单到 API */
  async function submitOrder(params: SubmitOrderParams): Promise<void> {
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
      return;
    }

    const resolvedPrice = overridePrice ?? signal?.price ?? null;

    // 格式化标的显示（用于日志）
    const symbolDisplayForLog = formatSymbolDisplay(symbol, signal.symbolName ?? null);

    // 市价单不需要价格
    if (orderTypeParam === OrderType.MO) {
      logger.info(`[订单类型] 使用市价单(MO)，标的=${symbolDisplayForLog}`);
    } else if (
      orderTypeParam === OrderType.LO ||
      orderTypeParam === OrderType.ELO ||
      orderTypeParam === OrderType.ALO ||
      orderTypeParam === OrderType.SLO
    ) {
      const orderTypeLabel = formatOrderTypeLabel(orderTypeParam);
      if (!resolvedPrice) {
        logger.warn(
          `[跳过订单] ${symbolDisplayForLog} 的${orderTypeLabel}缺少价格，无法提交。请确保信号中包含价格信息`,
        );
        return;
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
      ...(remark && { remark: `${remark}`.slice(0, 60) }),
    };

    try {
      await rateLimiter.throttle();
      if (!canExecuteSignal(signal, 'submitOrder.beforeApi')) {
        return;
      }
      const resp = await ctx.submitOrder(orderPayload);

      cacheManager.clearCache();

      const orderId = extractOrderId(resp);

      const actionDesc = getActionDescription(signal.action);

      logger.info(
        `[订单提交成功] ${actionDesc} ${orderPayload.symbol} 数量=${orderPayload.submittedQuantity.toString()} 订单ID=${orderId}`,
      );

      // ========== 开始追踪订单（由 orderMonitor 在成交后更新本地记录） ==========
      const submittedQuantityNum = decimalToNumber(orderPayload.submittedQuantity);
      const isLongSymbol = !isShortSymbol;
      const isProtectiveLiquidation = isLiquidationSignal(signal);
      orderMonitor.trackOrder({
        orderId: String(orderId),
        symbol,
        side,
        price: resolvedPrice ?? 0,
        quantity: submittedQuantityNum,
        isLongSymbol,
        monitorSymbol: monitorConfig?.monitorSymbol ?? null,
        isProtectiveLiquidation,
        orderType: orderTypeParam,
      });

      // 卖出订单注册防重追踪
      const isSellOrder = side === OrderSide.Sell;
      if (isSellOrder && signal.relatedBuyOrderIds) {
        const direction: 'LONG' | 'SHORT' = isLongSymbol ? 'LONG' : 'SHORT';
        orderRecorder.submitSellOrder(
          String(orderId),
          symbol,
          direction,
          submittedQuantityNum,
          signal.relatedBuyOrderIds,
        );
      }

      updateLastBuyTime(signal.action, monitorConfig);
    } catch (err) {
      handleSubmitError(err, signal, orderPayload);
    }
  }

  /**
   * 根据信号类型构建并提交订单。
   * 卖出时先查询可用持仓并执行卖单合并决策（REPLACE/CANCEL_AND_SUBMIT/SUBMIT/SKIP），
   * 买入时按目标金额计算数量后直接提交。
   * 返回是否实际提交了订单，供调用方判断是否需要更新缓存。
   */
  async function submitTargetOrder(
    ctx: TradeContext,
    signal: Signal,
    targetSymbol: string,
    isShortSymbol: boolean,
    monitorConfig: MonitorConfig | null = null,
  ): Promise<boolean> {
    // 验证信号对象
    if (!signal || typeof signal !== 'object') {
      logger.error(`[订单提交] 无效的信号对象: ${JSON.stringify(signal)}`);
      return false;
    }

    if (!signal.symbol || typeof signal.symbol !== 'string') {
      logger.error(`[订单提交] 信号缺少有效的标的代码: ${JSON.stringify(signal)}`);
      return false;
    }

    // 根据信号类型转换为订单方向
    const side = resolveOrderSide(signal.action);
    if (!side) {
      logger.error(`[订单提交] 未知的信号类型: ${signal.action}, 标的: ${signal.symbol}`);
      return false;
    }

    if (!canExecuteSignal(signal, 'submitTargetOrder')) {
      return false;
    }

    // 使用配置中的值，如果没有配置则使用默认值
    const targetNotional = monitorConfig?.targetNotional ?? TRADING.DEFAULT_TARGET_NOTIONAL;
    // lotSize 从信号对象获取（由配置解析或外部传入）
    // 订单类型解析：覆盖优先，其次保护性清仓
    const orderType = resolveOrderType(signal);
    const timeInForce = TimeInForceType.Day;
    const remark = 'QuantDemo';

    let submittedQtyDecimal: Decimal;

    // 判断是否需要清仓
    const needClosePosition = isSellAction(signal.action);

    if (needClosePosition) {
      submittedQtyDecimal = await calculateSellQuantity(ctx, targetSymbol, signal);
      if (submittedQtyDecimal.isZero()) {
        return false;
      }
      const submittedQtyNumber = decimalToNumber(submittedQtyDecimal);
      if (!isValidPositiveNumber(submittedQtyNumber)) {
        logger.warn(
          `[跳过订单] 卖出数量无效，无法合并卖单: ${submittedQtyNumber}, symbol=${targetSymbol}`,
        );
        return false;
      }

      const resolvedPrice = isValidPositiveNumber(signal.price) ? Number(signal.price) : null;
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
          return false;
        }
        const price = decision.price ?? resolvedPrice ?? 0;
        if (!isValidPositiveNumber(price)) {
          logger.warn(`[订单合并] 无法获取有效改单价格，跳过: ${targetSymbol}`);
          return false;
        }
        await orderMonitor.replaceOrderPrice(
          decision.targetOrderId,
          price,
          decision.mergedQuantity,
        );
        return false;
      }

      if (decision.action === 'CANCEL_AND_SUBMIT') {
        if (!canExecuteSignal(signal, 'cancelAndSubmit')) {
          return false;
        }
        const cancelResults = await Promise.all(
          decision.pendingOrderIds.map((orderId) => orderMonitor.cancelOrder(orderId)),
        );
        if (cancelResults.some((ok) => !ok)) {
          const remaining = orderMonitor.getPendingSellOrders(targetSymbol);
          if (remaining.length > 0) {
            logger.warn(`[订单合并] 撤单失败且仍有未成交卖单，跳过合并提交: ${targetSymbol}`);
            return false;
          }
        }
      }

      if (decision.action === 'SKIP') {
        logger.info(`[订单合并] 无需新增卖单: ${targetSymbol}, reason=${decision.reason}`);
        return false;
      }

      if (decision.action === 'SUBMIT' || decision.action === 'CANCEL_AND_SUBMIT') {
        const mergedQtyDecimal = toDecimal(decision.mergedQuantity);
        await submitOrder({
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
        return true;
      }
      return false;
    }

    submittedQtyDecimal = calculateBuyQuantity(signal, isShortSymbol, undefined, targetNotional);
    if (submittedQtyDecimal.isZero()) {
      return false;
    }

    await submitOrder({
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
    return true;
  }

  /** 执行交易信号（遍历信号数组，逐个提交订单）；返回实际提交的订单数量（用于保护性清仓等仅在真正提交后才更新缓存） */
  async function executeSignals(signals: Signal[]): Promise<{ submittedCount: number }> {
    if (!isExecutionAllowed()) {
      logger.info('[执行门禁] 门禁关闭，跳过本次下单，不提交任何订单');
      return { submittedCount: 0 };
    }

    const ctx = await ctxPromise;
    let submittedCount = 0;

    for (const s of signals) {
      // 验证信号对象
      if (!s || typeof s !== 'object') {
        logger.warn(`[跳过信号] 无效的信号对象: ${JSON.stringify(s)}`);
        continue;
      }

      if (!s.symbol || typeof s.symbol !== 'string') {
        logger.warn(`[跳过信号] 信号缺少有效的标的代码: ${JSON.stringify(s)}`);
        continue;
      }

      // 缓存格式化后的信号标的显示（用于早期退出的日志）
      const signalSymbolDisplay = formatSymbolDisplay(s.symbol, s.symbolName ?? null);

      if (s.action === 'HOLD') {
        logger.info(`[HOLD] ${signalSymbolDisplay} - ${s.reason || '持有'}`);
        continue;
      }

      // 保护性清仓不参与跨日/触发时间校验（实时风控，始终视为有效）
      if (!isLiquidationSignal(s) && isStaleCrossDaySignal(s, new Date())) {
        logger.info(
          `[执行门禁] 跨日或触发时间无效信号，跳过执行: ${signalSymbolDisplay} ${s.action}`,
        );
        continue;
      }

      if (!isExecutionAllowed()) {
        logger.info(`[执行门禁] 门禁已关闭，跳过信号: ${signalSymbolDisplay} ${s.action}`);
        continue;
      }

      // 验证信号类型
      const side = resolveOrderSide(s.action);
      if (!side) {
        logger.warn(`[跳过信号] 未知的信号类型: ${s.action}, 标的: ${signalSymbolDisplay}`);
        continue;
      }

      // 通过信号的 symbol 查找对应的监控配置
      const resolved = resolveMonitorConfigBySymbol(s.symbol);
      if (!resolved) {
        logger.warn(`[跳过信号] 无法找到信号标的 ${signalSymbolDisplay} 对应的监控配置`);
        continue;
      }

      const { monitorConfig, isShortSymbol } = resolved;
      const targetSymbol = s.symbol;

      // 根据信号类型显示操作描述
      const actualAction = getActionDescription(s.action);

      // 使用绿色显示交易计划（格式化标的显示：中文名称(代码)）
      const symbolDisplay = formatSymbolDisplay(targetSymbol, s.symbolName);
      logger.info(
        `${LOG_COLORS.green}[交易计划] ${actualAction} ${symbolDisplay} - ${s.reason || '策略信号'}${LOG_COLORS.reset}`,
      );

      const submitted = await submitTargetOrder(ctx, s, targetSymbol, isShortSymbol, monitorConfig);
      if (submitted) {
        submittedCount += 1;
      }
    }

    return { submittedCount };
  }

  return {
    canTradeNow,
    markBuyAttempt,
    executeSignals,
    resetBuyThrottle,
  };
}

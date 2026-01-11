/**
 * 订单执行模块
 *
 * 功能：
 * - 执行交易信号
 * - 提交买入/卖出订单
 * - 计算买入/卖出数量
 * - 管理交易频率限制
 */

import {
  TradeContext,
  OrderSide,
  OrderType,
  TimeInForceType,
  Decimal,
} from 'longport';
import { MULTI_MONITOR_TRADING_CONFIG } from '../../config/config.trading.js';
import { logger, colors } from '../../utils/logger/index.js';
import { TIME, TRADING } from '../../constants/index.js';
import {
  normalizeHKSymbol,
  decimalToNumber,
  formatError,
  isDefined,
  isBuyAction,
  isValidPositiveNumber,
} from '../../utils/helpers/index.js';
import type { Signal, TradeCheckResult, MonitorConfig } from '../../types/index.js';
import type { OrderPayload, OrderExecutor, OrderExecutorDeps } from './types.js';
import { recordTrade, identifyErrorType } from './tradeLogger.js';

/**
 * 通过信号的 symbol 查找对应的监控配置
 * @param signalSymbol 信号中的标的代码
 * @returns 匹配的监控配置，如果未找到则返回 null
 */
function findMonitorConfigBySymbol(signalSymbol: string): MonitorConfig | null {
  const normalizedSymbol = normalizeHKSymbol(signalSymbol);
  for (const config of MULTI_MONITOR_TRADING_CONFIG.monitors) {
    const configLongSymbol = normalizeHKSymbol(config.longSymbol);
    const configShortSymbol = normalizeHKSymbol(config.shortSymbol);
    if (normalizedSymbol === configLongSymbol || normalizedSymbol === configShortSymbol) {
      return config;
    }
  }
  // 未找到匹配的配置
  return null;
}

const toDecimal = (value: unknown): Decimal => {
  if (value instanceof Decimal) {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'string') {
    return new Decimal(value);
  }
  return Decimal.ZERO();
};

/**
 * 创建订单执行器
 * @param deps 依赖注入
 * @returns OrderExecutor 接口实例
 */
export const createOrderExecutor = (deps: OrderExecutorDeps): OrderExecutor => {
  const { ctxPromise, rateLimiter, cacheManager, orderMonitor } = deps;

  // 闭包捕获的私有状态
  // 记录每个监控标的的每个方向标的的最后买入时间
  // Key 格式: `${monitorSymbol}:${direction}` 例如 "700.HK:LONG"
  const lastBuyTime = new Map<string, number>();

  /**
   * 检查是否可以交易（仅对买入操作进行频率检查）
   * @param signalAction 信号类型
   * @param monitorConfig 监控配置（可选，如果提供则使用该配置的 buyIntervalSeconds）
   * @returns 交易检查结果，包含是否可以交易、需要等待的秒数等信息
   */
  const canTradeNow = (signalAction: string, monitorConfig?: MonitorConfig | null): TradeCheckResult => {
    // 卖出操作不触发频率限制
    if (signalAction === 'SELLCALL' || signalAction === 'SELLPUT') {
      return { canTrade: true };
    }

    // 确定方向：BUYCALL 是 LONG，BUYPUT 是 SHORT
    const direction: 'LONG' | 'SHORT' = signalAction === 'BUYCALL' ? 'LONG' : 'SHORT';

    // 使用配置中的 buyIntervalSeconds，如果没有配置则使用默认值
    const buyIntervalSeconds = monitorConfig?.buyIntervalSeconds ?? 60;

    // 使用监控标的符号作为键的一部分，以支持多个监控标的
    const monitorSymbol = monitorConfig?.monitorSymbol ?? '';
    const timeKey = monitorSymbol ? `${monitorSymbol}:${direction}` : direction;

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
  };

  /**
   * 更新方向标的的最后买入时间
   */
  const updateLastBuyTime = (signalAction: string, monitorConfig?: MonitorConfig | null): void => {
    if (signalAction === 'BUYCALL' || signalAction === 'BUYPUT') {
      const direction = signalAction === 'BUYCALL' ? 'LONG' : 'SHORT';
      const monitorSymbol = monitorConfig?.monitorSymbol ?? '';
      const timeKey = monitorSymbol ? `${monitorSymbol}:${direction}` : direction;
      lastBuyTime.set(timeKey, Date.now());
    }
  };

  /**
   * 根据信号类型和订单方向获取操作描述
   */
  const getActionDescription = (
    signalAction: string,
    isShortSymbol: boolean,
    side: typeof OrderSide[keyof typeof OrderSide],
  ): string => {
    if (signalAction === 'BUYCALL') {
      return '买入做多标的（做多）';
    }
    if (signalAction === 'SELLCALL') {
      return '卖出做多标的（清仓）';
    }
    if (signalAction === 'BUYPUT') {
      return '买入做空标的（做空）';
    }
    if (signalAction === 'SELLPUT') {
      return '卖出做空标的（平空仓）';
    }

    // 兼容旧代码
    if (isShortSymbol) {
      return side === OrderSide.Buy
        ? '买入做空标的（做空）'
        : '卖出做空标的（平空仓）';
    }
    return side === OrderSide.Buy
      ? '买入做多标的（做多）'
      : '卖出做多标的（清仓）';
  };

  /**
   * 计算卖出数量
   */
  const calculateSellQuantity = async (
    ctx: TradeContext,
    symbol: string,
    signal: Signal,
  ): Promise<Decimal> => {
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
    } else {
      const actualQty = Math.min(targetQuantity, totalAvailable);
      logger.info(
        `[部分卖出] 信号指定卖出数量=${targetQuantity}，可用数量=${totalAvailable}，实际卖出=${actualQty}`,
      );
      return toDecimal(actualQty);
    }
  };

  /**
   * 计算买入数量
   */
  const calculateBuyQuantity = (
    signal: Signal,
    isShortSymbol: boolean,
    overridePrice: number | undefined,
    quantity: number,
    targetNotional: number,
    monitorConfig: MonitorConfig | null,
  ): Decimal => {
    const pricingSource = overridePrice ?? signal?.price ?? null;
    if (!Number.isFinite(Number(pricingSource)) || Number(pricingSource) <= 0) {
      logger.warn(
        `[跳过订单] 无法获取有效价格，无法按金额计算买入数量，price=${pricingSource}`,
      );
      const fallbackQty = toDecimal(quantity);
      if (!fallbackQty || fallbackQty.isZero() || fallbackQty.isNegative()) {
        logger.warn(
          `[跳过订单] 预设买入数量非法（${quantity}），跳过提交订单`,
        );
        return Decimal.ZERO();
      }
      return fallbackQty;
    }

    const notional = Number(
      targetNotional &&
        Number.isFinite(Number(targetNotional)) &&
        targetNotional > 0
        ? targetNotional
        : TRADING.DEFAULT_TARGET_NOTIONAL,
    );
    const priceNum = Number(pricingSource);

    if (!Number.isFinite(priceNum) || priceNum <= 0) {
      logger.warn(
        `[跳过订单] 价格无效，无法计算买入数量，price=${priceNum}`,
      );
      return Decimal.ZERO();
    }

    let rawQty = Math.floor(notional / priceNum);

    // 获取最小买卖单位
    let lotSize: number = signal?.lotSize ?? 0;

    // 如果信号中没有有效的 lotSize，使用配置中的值
    if (!Number.isFinite(lotSize) || lotSize <= 0) {
      if (monitorConfig) {
        if (isShortSymbol) {
          lotSize = monitorConfig.shortLotSize ?? 0;
        } else {
          lotSize = monitorConfig.longLotSize ?? 0;
        }
      }
    }

    // 如果配置中的值也无效，使用默认值
    if (!Number.isFinite(lotSize) || lotSize <= 0) {
      lotSize = TRADING.DEFAULT_LOT_SIZE;
    }

    // 此时 lotSize 一定是有效的正数
    rawQty = Math.floor(rawQty / lotSize) * lotSize;
    if (!Number.isFinite(rawQty) || rawQty < lotSize) {
      logger.warn(
        `[跳过订单] 目标金额(${notional}) 相对于价格(${priceNum}) 太小，按每手 ${lotSize} 股计算得到数量=${rawQty}，跳过提交订单`,
      );
      return Decimal.ZERO();
    }

    const actionType = isShortSymbol
      ? '买入做空标的（做空）'
      : '买入做多标的（做多）';
    logger.info(
      `[仓位计算] 按目标金额 ${notional} 计算得到${actionType}数量=${rawQty} 股（${lotSize} 股一手），单价≈${priceNum}`,
    );

    return toDecimal(rawQty);
  };

  /**
   * 处理订单提交错误
   */
  const handleSubmitError = (
    err: unknown,
    signal: Signal,
    orderPayload: OrderPayload,
    side: typeof OrderSide[keyof typeof OrderSide],
    isShortSymbol: boolean,
    actualOrderType: typeof OrderType[keyof typeof OrderType],
  ): void => {
    const actionDesc = getActionDescription(
      signal.action,
      isShortSymbol,
      side,
    );

    const errorMessage = formatError(err);
    const errorType = identifyErrorType(errorMessage);

    // 根据错误类型进行针对性处理
    if (errorType.isShortSellingNotSupported) {
      logger.error(
        `[订单提交失败] ${actionDesc} ${orderPayload.symbol} 失败：该标的不支持做空交易`,
        errorMessage,
      );
      logger.warn(
        `[做空错误提示] 标的 ${orderPayload.symbol} 不支持做空交易。可能的原因：\n` +
          '  1. 该标的在港股市场不支持做空\n' +
          '  2. 账户没有做空权限\n' +
          '  3. 需要更换其他支持做空的标的\n' +
          '  建议：检查配置中的 SHORT_SYMBOL 环境变量，或联系券商确认账户做空权限',
      );
    } else if (errorType.isInsufficientFunds) {
      logger.error(
        `[订单提交失败] ${actionDesc} ${orderPayload.symbol} 失败：账户资金不足`,
        errorMessage,
      );
    } else if (errorType.isNetworkError) {
      logger.error(
        `[订单提交失败] ${actionDesc} ${orderPayload.symbol} 失败：网络异常，请检查连接`,
        errorMessage,
      );
    } else if (errorType.isRateLimited) {
      logger.error(
        `[订单提交失败] ${actionDesc} ${orderPayload.symbol} 失败：API 调用频率超限`,
        errorMessage,
      );
    } else {
      logger.error(
        `[订单提交失败] ${actionDesc} ${orderPayload.symbol} 失败：`,
        errorMessage,
      );
    }

    // 记录失败交易到文件
    recordTrade({
      orderId: 'FAILED',
      symbol: orderPayload.symbol,
      symbolName: signal.symbolName || null,
      action: actionDesc,
      side: signal.action || (side === OrderSide.Buy ? 'BUY' : 'SELL'),
      quantity: orderPayload.submittedQuantity.toString(),
      price: orderPayload.submittedPrice?.toString() || '市价',
      orderType: actualOrderType === OrderType.MO ? '市价单' : '限价单',
      status: 'FAILED',
      error: errorMessage,
      reason: signal.reason || '策略信号',
      signalTriggerTime: signal.signalTriggerTime || null,
    });
  };

  /**
   * 提交订单（核心方法）
   */
  const submitOrder = async (
    ctx: TradeContext,
    signal: Signal,
    symbol: string,
    side: typeof OrderSide[keyof typeof OrderSide],
    submittedQtyDecimal: Decimal,
    useMarketOrder: boolean,
    orderTypeParam: typeof OrderType[keyof typeof OrderType],
    timeInForce: typeof TimeInForceType[keyof typeof TimeInForceType],
    remark: string | undefined,
    overridePrice: number | undefined,
    isShortSymbol: boolean,
    monitorConfig: MonitorConfig | null = null,
  ): Promise<void> => {
    // 确定实际使用的订单类型
    const actualOrderType = useMarketOrder ? OrderType.MO : orderTypeParam;

    const resolvedPrice = overridePrice ?? signal?.price ?? null;

    // 市价单不需要价格
    if (actualOrderType === OrderType.MO) {
      logger.info(`[订单类型] 使用市价单(MO)进行保护性清仓，标的=${symbol}`);
    } else if (
      actualOrderType === OrderType.LO ||
      actualOrderType === OrderType.ELO ||
      actualOrderType === OrderType.ALO ||
      actualOrderType === OrderType.SLO
    ) {
      if (!resolvedPrice) {
        logger.warn(
          `[跳过订单] ${symbol} 的增强限价单缺少价格，无法提交。请确保信号中包含价格信息`,
        );
        return;
      }
      logger.info(
        `[订单类型] 使用增强限价单(ELO)，标的=${symbol}，价格=${resolvedPrice}`,
      );
    }

    // 构建订单载荷（不可变方式，一次性创建包含所有字段的对象）
    const orderPayload: OrderPayload = {
      symbol,
      orderType: actualOrderType,
      side,
      timeInForce,
      submittedQuantity: submittedQtyDecimal,
      // 仅在需要时添加价格字段
      ...(resolvedPrice && actualOrderType !== OrderType.MO && { submittedPrice: toDecimal(resolvedPrice) }),
      // 仅在有备注时添加备注字段
      ...(remark && { remark: `${remark}`.slice(0, 60) }),
    };

    try {
      await rateLimiter.throttle();
      const resp = await ctx.submitOrder(orderPayload);

      cacheManager.clearCache();

      const orderId =
        (resp as { orderId?: string })?.orderId ?? resp?.toString?.() ?? resp ?? 'UNKNOWN_ORDER_ID';

      const actionDesc = getActionDescription(
        signal.action,
        isShortSymbol,
        side,
      );

      logger.info(
        `[订单提交成功] ${actionDesc} ${
          orderPayload.symbol
        } 数量=${orderPayload.submittedQuantity.toString()} 订单ID=${orderId}`,
      );

      updateLastBuyTime(signal.action, monitorConfig);

      recordTrade({
        orderId: String(orderId),
        symbol: orderPayload.symbol,
        symbolName: signal.symbolName || null,
        action: actionDesc,
        side: signal.action || (side === OrderSide.Buy ? 'BUY' : 'SELL'),
        quantity: orderPayload.submittedQuantity.toString(),
        price: orderPayload.submittedPrice?.toString() || '市价',
        orderType: actualOrderType === OrderType.MO ? '市价单' : '限价单',
        status: 'SUBMITTED',
        reason: signal.reason || '策略信号',
        signalTriggerTime: signal.signalTriggerTime || null,
      });
    } catch (err) {
      handleSubmitError(err, signal, orderPayload, side, isShortSymbol, actualOrderType);
    }
  };

  /**
   * 提交目标订单
   */
  const submitTargetOrder = async (
    ctx: TradeContext,
    signal: Signal,
    targetSymbol: string,
    isShortSymbol: boolean = false,
    monitorConfig: MonitorConfig | null = null,
  ): Promise<void> => {
    // 验证信号对象
    if (!signal || typeof signal !== 'object') {
      logger.error(`[订单提交] 无效的信号对象: ${JSON.stringify(signal)}`);
      return;
    }

    if (!signal.symbol || typeof signal.symbol !== 'string') {
      logger.error(
        `[订单提交] 信号缺少有效的标的代码: ${JSON.stringify(signal)}`,
      );
      return;
    }

    // 根据信号类型转换为订单方向
    let side: typeof OrderSide[keyof typeof OrderSide];
    if (signal.action === 'BUYCALL') {
      side = OrderSide.Buy;
    } else if (signal.action === 'SELLCALL') {
      side = OrderSide.Sell;
    } else if (signal.action === 'BUYPUT') {
      side = OrderSide.Buy;
    } else if (signal.action === 'SELLPUT') {
      side = OrderSide.Sell;
    } else {
      logger.error(
        `[订单提交] 未知的信号类型: ${signal.action}, 标的: ${signal.symbol}`,
      );
      return;
    }

    // 使用配置中的值，如果没有配置则使用默认值
    const targetNotional = monitorConfig?.targetNotional ?? TRADING.DEFAULT_TARGET_NOTIONAL;
    const quantity = isShortSymbol
      ? (monitorConfig?.shortLotSize ?? TRADING.DEFAULT_LOT_SIZE)
      : (monitorConfig?.longLotSize ?? TRADING.DEFAULT_LOT_SIZE);
    const orderType = OrderType.ELO;
    const timeInForce = TimeInForceType.Day;
    const remark = 'QuantDemo';
    const overridePrice = undefined;
    const symbol = targetSymbol;

    // 检查信号是否要求使用市价单
    const useMarketOrder = signal.useMarketOrder === true;

    let submittedQtyDecimal: Decimal;

    // 判断是否需要清仓
    const needClosePosition =
      signal.action === 'SELLCALL' || signal.action === 'SELLPUT';

    if (needClosePosition) {
      submittedQtyDecimal = await calculateSellQuantity(
        ctx,
        symbol,
        signal,
      );
      if (submittedQtyDecimal.isZero()) {
        return;
      }
    } else {
      submittedQtyDecimal = calculateBuyQuantity(
        signal,
        isShortSymbol,
        overridePrice,
        quantity,
        targetNotional,
        monitorConfig,
      );
      if (submittedQtyDecimal.isZero()) {
        return;
      }
    }

    await submitOrder(
      ctx,
      signal,
      symbol,
      side,
      submittedQtyDecimal,
      useMarketOrder,
      orderType,
      timeInForce,
      remark,
      overridePrice,
      isShortSymbol,
      monitorConfig,
    );
  };

  /**
   * 根据策略信号提交订单
   * @param signals 信号数组
   */
  const executeSignals = async (signals: Signal[]): Promise<void> => {
    const ctx = await ctxPromise;

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

      if (s.action === 'HOLD') {
        logger.info(`[HOLD] ${s.symbol} - ${s.reason || '持有'}`);
        continue;
      }

      // 验证信号类型
      const validActions = ['BUYCALL', 'SELLCALL', 'BUYPUT', 'SELLPUT'];
      if (!validActions.includes(s.action)) {
        logger.warn(
          `[跳过信号] 未知的信号类型: ${s.action}, 标的: ${s.symbol}`,
        );
        continue;
      }

      // 通过信号的 symbol 查找对应的监控配置
      const monitorConfig = findMonitorConfigBySymbol(s.symbol);
      if (!monitorConfig) {
        logger.warn(
          `[跳过信号] 无法找到信号标的 ${s.symbol} 对应的监控配置`,
        );
        continue;
      }

      const normalizedSignalSymbol = normalizeHKSymbol(s.symbol);
      const normalizedLongSymbol = normalizeHKSymbol(monitorConfig.longSymbol);
      const normalizedShortSymbol = normalizeHKSymbol(monitorConfig.shortSymbol);
      const isShortSymbol = normalizedSignalSymbol === normalizedShortSymbol;
      const targetSymbol = isShortSymbol ? normalizedShortSymbol : normalizedLongSymbol;

      // 根据信号类型显示操作描述
      let actualAction = '';
      if (s.action === 'BUYCALL') {
        actualAction = '买入做多标的（做多）';
      } else if (s.action === 'SELLCALL') {
        actualAction = '卖出做多标的（平仓）';
      } else if (s.action === 'BUYPUT') {
        actualAction = '买入做空标的（做空）';
      } else if (s.action === 'SELLPUT') {
        actualAction = '卖出做空标的（平仓）';
      } else {
        actualAction = `未知操作(${s.action})`;
      }

      // 使用绿色显示交易计划
      logger.info(
        `${colors.green}[交易计划] ${actualAction} ${targetSymbol} - ${
          s.reason || '策略信号'
        }${colors.reset}`,
      );

      await submitTargetOrder(ctx, s, targetSymbol, isShortSymbol, monitorConfig);

      // 如果发起了买入交易，启用监控
      if (isBuyAction(s.action)) {
        orderMonitor.enableMonitoring();
        logger.info('[订单监控] 已发起买入交易，开始监控买入订单');
      }
    }
  };

  return {
    canTradeNow,
    executeSignals,
  };
};

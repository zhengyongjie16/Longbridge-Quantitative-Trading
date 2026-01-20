/**
 * 信号处理模块
 *
 * 功能：
 * - 对生成的信号进行过滤和风险检查
 * - 计算卖出信号的数量和清仓策略
 * - 实施交易频率限制
 *
 * 买入检查顺序：
 * 1. 交易频率限制（同方向买入时间间隔）
 * 2. 买入价格限制（防止追高）
 * 3. 末日保护程序（收盘前 15 分钟拒绝买入）
 * 4. 牛熊证风险检查
 * 5. 基础风险检查（浮亏和持仓限制）
 *
 * 卖出策略：
 * - currentPrice > costPrice：清空所有持仓
 * - currentPrice ≤ costPrice：仅卖出盈利部分订单
 * - 无符合条件订单：信号设为 HOLD
 */

import { logger } from '../../utils/logger/index.js';
import { normalizeHKSymbol, getSymbolName, getDirectionName, formatSymbolDisplayFromQuote, formatError } from '../../utils/helpers/index.js';
import { MULTI_MONITOR_TRADING_CONFIG } from '../../config/config.trading.js';
import { VERIFICATION } from '../../constants/index.js';
import type { Quote, Position, Signal, OrderRecorder, AccountSnapshot } from '../../types/index.js';
import type { RiskCheckContext, SellQuantityResult, SignalProcessor, SignalProcessorDeps } from './types.js';

/**
 * 记录每个标的每个方向最近一次进入风险检查的时间
 * 格式: Map<`${symbol}_${direction}`, timestamp>
 * 用于实现验证信号冷却机制，避免同标的同方向的重复信号在短时间内多次触发风险检查
 */
const lastRiskCheckTime = new Map<string, number>();

/**
 * 验证持仓和行情数据是否有效
 */
function isValidPositionAndQuote(
  position: Position | null,
  quote: Quote | null,
): position is Position & { costPrice: number; availableQuantity: number } {
  return (
    position !== null &&
    Number.isFinite(position.costPrice) &&
    position.costPrice !== null &&
    position.costPrice > 0 &&
    Number.isFinite(position.availableQuantity) &&
    position.availableQuantity !== null &&
    position.availableQuantity > 0 &&
    quote !== null &&
    Number.isFinite(quote.price) &&
    quote.price !== null &&
    quote.price > 0
  );
}

/**
 * 格式化价格比较描述
 */
function formatPriceComparison(
  directionName: string,
  currentPrice: number,
  costPrice: number,
): string {
  return `${directionName}价格${currentPrice.toFixed(3)}未高于成本价${costPrice.toFixed(3)}`;
}

/**
 * 计算卖出信号的数量和原因
 * 统一处理做多和做空标的的卖出逻辑
 *
 * 卖出策略规则（智能平仓开启时）：
 * 1. 如果当前价格 > 持仓成本价：立即清仓所有持仓
 * 2. 如果当前价格 <= 持仓成本价：仅卖出买入价低于当前价的历史订单（盈利部分）
 * 3. 如果没有符合条件的订单或数据无效：跳过此信号（shouldHold=true）
 *
 * 卖出策略规则（智能平仓关闭时）：
 * 直接清仓所有持仓，不检查成本价
 *
 * @param position 持仓信息
 * @param quote 行情数据
 * @param orderRecorder 订单记录器
 * @param direction 方向（LONG 或 SHORT）
 * @param originalReason 原始原因
 * @param smartCloseEnabled 是否启用智能平仓
 * @param symbol 标的代码（必须指定，用于多标的场景下精确筛选订单记录）
 */
function calculateSellQuantity(
  position: Position | null,
  quote: Quote | null,
  orderRecorder: OrderRecorder | null,
  direction: 'LONG' | 'SHORT',
  originalReason: string,
  smartCloseEnabled: boolean,
  symbol: string,
): SellQuantityResult {
  const reason = originalReason || '';
  const directionName = getDirectionName(direction === 'LONG');

  // 验证输入参数
  if (!isValidPositionAndQuote(position, quote)) {
    return {
      quantity: null,
      shouldHold: true,
      reason: `${reason}，持仓或行情数据无效`,
    };
  }

  // 类型守卫已验证 quote 不为 null，这里使用非空断言
  const currentPrice = quote!.price;
  const costPrice = position.costPrice;

  // 智能平仓关闭：直接清仓所有持仓，不检查成本价
  if (!smartCloseEnabled) {
    return {
      quantity: position.availableQuantity,
      shouldHold: false,
      reason: `${reason}，智能平仓已关闭，直接清空所有${directionName}持仓`,
    };
  }

  // 当前价格高于持仓成本价，立即清仓所有持仓
  if (currentPrice > costPrice) {
    return {
      quantity: position.availableQuantity,
      shouldHold: false,
      reason: `${reason}，当前价格${currentPrice.toFixed(3)}>成本价${costPrice.toFixed(3)}，立即清空所有${directionName}持仓`,
    };
  }

  // 当前价格没有高于持仓成本价，检查历史买入订单
  const priceComparisonDesc = formatPriceComparison(directionName, currentPrice, costPrice);

  if (!orderRecorder) {
    return {
      quantity: null,
      shouldHold: true,
      reason: `${reason}，但${priceComparisonDesc}，且无法获取订单记录`,
    };
  }

  // 根据方向和标的获取符合条件的买入订单
  // 传入 symbol 参数以精确筛选，避免多标的支持时的混淆
  const buyOrdersBelowPrice = orderRecorder.getBuyOrdersBelowPrice(currentPrice, direction, symbol);

  if (!buyOrdersBelowPrice || buyOrdersBelowPrice.length === 0) {
    return {
      quantity: null,
      shouldHold: true,
      reason: `${reason}，但${priceComparisonDesc}，且没有买入价低于当前价的历史订单`,
    };
  }

  const totalQuantity = Math.min(
    orderRecorder.calculateTotalQuantity(buyOrdersBelowPrice),
    position.availableQuantity,
  );

  if (totalQuantity > 0) {
    return {
      quantity: totalQuantity,
      shouldHold: false,
      reason: `${reason}，但${priceComparisonDesc}，卖出历史买入订单中买入价低于当前价的订单，共 ${totalQuantity} 股`,
    };
  }

  return {
    quantity: null,
    shouldHold: true,
    reason: `${reason}，但${priceComparisonDesc}，且没有买入价低于当前价的历史订单`,
  };
}

/**
 * 创建信号处理器
 * @param _deps 依赖注入（当前为空）
 * @returns SignalProcessor 接口实例
 */
export const createSignalProcessor = (_deps: SignalProcessorDeps = {}): SignalProcessor => {
  /**
   * 处理卖出信号的成本价判断和数量计算
   */
  const processSellSignals = (
    signals: Signal[],
    longPosition: Position | null,
    shortPosition: Position | null,
    longQuote: Quote | null,
    shortQuote: Quote | null,
    orderRecorder: OrderRecorder,
    smartCloseEnabled: boolean = true,
  ): Signal[] => {
    for (const sig of signals) {
      // 只处理卖出信号（SELLCALL 和 SELLPUT），跳过买入信号
      if (sig.action !== 'SELLCALL' && sig.action !== 'SELLPUT') {
        continue;
      }

      // 根据信号类型确定对应的持仓和行情
      const isLongSignal = sig.action === 'SELLCALL';
      const position = isLongSignal ? longPosition : shortPosition;
      const quote = isLongSignal ? longQuote : shortQuote;
      const direction: 'LONG' | 'SHORT' = isLongSignal ? 'LONG' : 'SHORT';
      const signalName = isLongSignal ? 'SELLCALL' : 'SELLPUT';

      // 检查是否是末日保护程序的清仓信号（无条件清仓，不受成本价判断影响）
      const isDoomsdaySignal =
        sig.reason?.includes('末日保护程序');

      // 添加调试日志
      if (!position) {
        logger.warn(
          `[卖出信号处理] ${signalName}: ${direction === 'LONG' ? '做多' : '做空'}标的持仓对象为null，无法计算卖出数量`,
        );
      }
      if (!quote) {
        logger.warn(
          `[卖出信号处理] ${signalName}: ${direction === 'LONG' ? '做多' : '做空'}标的行情数据为null，无法计算卖出数量`,
        );
      }
      if (position && quote && position.costPrice !== null && quote.price !== null) {
        logger.info(
          `[卖出信号处理] ${signalName}: 持仓成本价=${position.costPrice.toFixed(
            3,
          )}, 当前价格=${quote.price.toFixed(3)}, 可用数量=${
            position.availableQuantity
          }`,
        );
      }

      if (isDoomsdaySignal) {
        // 末日保护程序：无条件清仓，使用全部可用数量
        if (position && position.availableQuantity !== null && position.availableQuantity > 0) {
          sig.quantity = position.availableQuantity;
          // 设置价格和最小买卖单位（从行情数据获取，仅在缺失时设置）
          if (quote?.price != null) {
            sig.price ??= quote.price;
          }
          if (quote?.lotSize != null) {
            sig.lotSize ??= quote.lotSize;
          }
          logger.info(
            `[卖出信号处理] ${signalName}(末日保护): 无条件清仓，卖出数量=${sig.quantity}`,
          );
        } else {
          logger.warn(
            `[卖出信号处理] ${signalName}(末日保护): 持仓对象无效，无法清仓`,
          );
          sig.action = 'HOLD';
          sig.reason = `${sig.reason}，但持仓对象无效`;
        }
      } else {
        // 正常卖出信号：根据智能平仓配置进行成本价判断
        // 传入 sig.symbol 以精确筛选订单记录（多标的支持）
        const result = calculateSellQuantity(
          position,
          quote,
          orderRecorder,
          direction,
          sig.reason || '',
          smartCloseEnabled,
          sig.symbol,
        );
        if (result.shouldHold) {
          logger.info(`[卖出信号处理] ${signalName}被跳过: ${result.reason}`);
          sig.action = 'HOLD';
          sig.reason = result.reason;
        } else {
          logger.info(
            `[卖出信号处理] ${signalName}通过: 卖出数量=${result.quantity}, 原因=${result.reason}`,
          );
          sig.quantity = result.quantity;
          sig.reason = result.reason;
          // 设置价格和最小买卖单位（从行情数据获取，仅在缺失时设置）
          if (quote?.price != null) {
            sig.price ??= quote.price;
          }
          if (quote?.lotSize != null) {
            sig.lotSize ??= quote.lotSize;
          }
        }
      }
    }

    return signals;
  };

  /**
   * 应用风险检查到信号列表
   */
  const applyRiskChecks = async (signals: Signal[], context: RiskCheckContext): Promise<Signal[]> => {
    const {
      trader,
      riskChecker,
      orderRecorder,
      longQuote,
      shortQuote,
      monitorQuote,
      monitorSnapshot,
      longSymbol,
      shortSymbol,
      longSymbolName,
      shortSymbolName,
      currentTime,
      isHalfDay,
      doomsdayProtection,
    } = context;

    const normalizedLongSymbol = normalizeHKSymbol(longSymbol);
    const normalizedShortSymbol = normalizeHKSymbol(shortSymbol);

    // 步骤1：在 API 调用之前先过滤冷却期内的信号
    // 这样可以避免所有买入信号都在冷却期内时的无效 API 调用
    const now = Date.now();
    const cooldownMs = VERIFICATION.VERIFIED_SIGNAL_COOLDOWN_SECONDS * 1000;
    const signalsAfterCooldown: Signal[] = [];

    for (const sig of signals) {
      const normalizedSigSymbol = sig.symbol;
      const direction = sig.action === 'BUYCALL' || sig.action === 'BUYPUT' ? 'BUY' : 'SELL';
      const cooldownKey = `${normalizedSigSymbol}_${direction}`;
      const lastTime = lastRiskCheckTime.get(cooldownKey);

      if (lastTime && now - lastTime < cooldownMs) {
        const remainingSeconds = Math.ceil((lastTime + cooldownMs - now) / 1000);
        const sigName = getSymbolName(
          sig.symbol,
          longSymbol,
          shortSymbol,
          longSymbolName,
          shortSymbolName,
        );
        logger.debug(
          `[验证冷却] ${sigName}(${normalizedSigSymbol}) ${sig.action} 在冷却期内，剩余 ${remainingSeconds} 秒，跳过风险检查`,
        );
        // 被冷却跳过的信号会在主循环中通过 validSignals.filter 被识别并释放到对象池
      } else {
        signalsAfterCooldown.push(sig);
      }
    }

    // 如果所有信号都被冷却拦截，直接返回空数组
    if (signalsAfterCooldown.length === 0) {
      return [];
    }

    // 步骤2：检查过滤后是否有买入信号，决定是否调用 API
    const hasBuySignals = signalsAfterCooldown.some(
      (s) => s.action === 'BUYCALL' || s.action === 'BUYPUT',
    );

    let freshAccount: AccountSnapshot | null = null;
    let freshPositions: Position[] = [];
    let buyApiFetchFailed = false;

    if (hasBuySignals) {
      try {
        [freshAccount, freshPositions] = await Promise.all([
          trader.getAccountSnapshot(),
          trader.getStockPositions(),
        ]);
      } catch (err) {
        logger.warn(
          '[风险检查] 批量获取账户和持仓信息失败，买入信号将被拒绝',
          formatError(err),
        );
        buyApiFetchFailed = true;
      }
    }

    const finalSignals: Signal[] = [];

    // 步骤3：遍历过滤后的信号进行风险检查
    for (const sig of signalsAfterCooldown) {
      const normalizedSigSymbol = sig.symbol;
      const sigName = getSymbolName(
        sig.symbol,
        longSymbol,
        shortSymbol,
        longSymbolName,
        shortSymbolName,
      );

      // 标记进入风险检查的时间（在处理信号前标记，确保后续相同信号被冷却）
      const direction = sig.action === 'BUYCALL' || sig.action === 'BUYPUT' ? 'BUY' : 'SELL';
      const cooldownKey = `${normalizedSigSymbol}_${direction}`;
      lastRiskCheckTime.set(cooldownKey, now);

      // 获取标的的当前价格用于计算持仓市值
      let currentPrice: number | null = null;
      if (normalizedSigSymbol === normalizedLongSymbol && longQuote) {
        currentPrice = longQuote.price;
      } else if (normalizedSigSymbol === normalizedShortSymbol && shortQuote) {
        currentPrice = shortQuote.price;
      }

      // 检查是否是买入操作
      const isBuyActionCheck =
        sig.action === 'BUYCALL' || sig.action === 'BUYPUT';

      if (isBuyActionCheck) {
        if (buyApiFetchFailed) {
          logger.warn(
            `[风险检查] 买入操作无法获取账户信息，跳过该信号：${sigName}(${normalizedSigSymbol}) ${sig.action}`,
          );
          continue;
        }

        // 买入操作检查顺序：
        // 1. 交易频率限制
        // 2. 买入价格限制
        // 3. 末日保护程序
        // 4. 牛熊证风险
        // 5. 基础风险检查

        // 1. 检查交易频率限制
        const tradeCheck = trader._canTradeNow(sig.action, context.config);
        if (!tradeCheck.canTrade) {
          const directionDesc = sig.action === 'BUYCALL' ? '做多标的' : '做空标的';
          logger.warn(
            `[交易频率限制] ${directionDesc} 在${context.config.buyIntervalSeconds}秒内已买入过，需等待 ${tradeCheck.waitSeconds ?? 0} 秒后才能再次买入：${sigName}(${normalizedSigSymbol}) ${sig.action}`,
          );
          continue;
        }

        // 频率检查通过后立即标记买入意图（预占时间槽）
        // 防止同一批次中的多个延迟验证信号同时通过频率检查
        trader._markBuyAttempt(sig.action, context.config);

        // 2. 买入价格限制
        const isLongBuyAction = sig.action === 'BUYCALL';
        const latestBuyPrice = orderRecorder.getLatestBuyOrderPrice(
          normalizedSigSymbol,
          isLongBuyAction,
        );

        if (latestBuyPrice !== null && currentPrice !== null) {
          const directionDesc = isLongBuyAction ? '做多标的' : '做空标的';
          const currentPriceStr = currentPrice.toFixed(3);
          const latestBuyPriceStr = latestBuyPrice.toFixed(3);
          const signalDesc = `${sigName}(${normalizedSigSymbol}) ${sig.action}`;

          if (currentPrice > latestBuyPrice) {
            logger.warn(
              `[买入价格限制] ${directionDesc} 当前价格 ${currentPriceStr} 高于最新买入订单价格 ${latestBuyPriceStr}，拒绝买入：${signalDesc}`,
            );
            continue;
          }
          logger.info(
            `[买入价格限制] ${directionDesc} 当前价格 ${currentPriceStr} 低于或等于最新买入订单价格 ${latestBuyPriceStr}，允许买入：${signalDesc}`,
          );
        }

        // 3. 末日保护程序：收盘前15分钟拒绝买入
        if (
          MULTI_MONITOR_TRADING_CONFIG.global.doomsdayProtection &&
          doomsdayProtection.shouldRejectBuy(currentTime, isHalfDay)
        ) {
          const closeTimeRange = isHalfDay ? '11:45-12:00' : '15:45-16:00';
          logger.warn(
            `[末日保护程序] 收盘前15分钟内拒绝买入：${sigName}(${normalizedSigSymbol}) ${sig.action} - 当前时间在${closeTimeRange}范围内`,
          );
          continue;
        }

        // 4. 检查牛熊证风险
        const monitorCurrentPrice =
          monitorQuote?.price ?? monitorSnapshot?.price ?? null;

        const warrantRiskResult = riskChecker.checkWarrantRisk(
          sig.symbol,
          sig.action,
          monitorCurrentPrice ?? 0,
        );

        if (!warrantRiskResult.allowed) {
          logger.warn(
            `[牛熊证风险拦截] 信号被牛熊证风险控制拦截：${sigName}(${normalizedSigSymbol}) ${sig.action} - ${warrantRiskResult.reason}`,
          );
          continue;
        } else if (warrantRiskResult.warrantInfo?.isWarrant) {
          const warrantType =
            warrantRiskResult.warrantInfo.warrantType === 'BULL'
              ? '牛证'
              : '熊证';
          const distancePercent =
            warrantRiskResult.warrantInfo.distanceToStrikePercent;

          // 使用 formatSymbolDisplayFromQuote 格式化标的显示
          let quoteForSymbol: Quote | null = null;

          if (normalizedSigSymbol === normalizedLongSymbol) {
            quoteForSymbol = longQuote;
          } else if (normalizedSigSymbol === normalizedShortSymbol) {
            quoteForSymbol = shortQuote;
          }

          const symbolDisplay = formatSymbolDisplayFromQuote(quoteForSymbol, sig.symbol);

          logger.info(
            `[牛熊证风险检查] ${symbolDisplay} 为${warrantType}，距离回收价百分比：${
              distancePercent?.toFixed(2) ?? '未知'
            }%，风险检查通过`,
          );
        }
      }

      // 5. 基础风险检查
      // 买入信号使用实时数据，卖出信号使用缓存数据
      const accountForRiskCheck = isBuyActionCheck ? freshAccount : context.account;
      const positionsForRiskCheck = isBuyActionCheck ? freshPositions : (context.positions ?? []);

      if (isBuyActionCheck && accountForRiskCheck === null) {
        logger.warn(
          `[风险检查] 买入操作无法获取账户信息，跳过该信号：${sigName}(${normalizedSigSymbol}) ${sig.action}`,
        );
        continue;
      }

      // 使用选择的数据进行风险检查
      const orderNotional = context.config.targetNotional ?? 0;
      const longCurrentPrice = longQuote?.price ?? null;
      const shortCurrentPrice = shortQuote?.price ?? null;
      const riskResult = riskChecker.checkBeforeOrder(
        accountForRiskCheck,
        positionsForRiskCheck,
        sig,
        orderNotional,
        currentPrice,
        longCurrentPrice,
        shortCurrentPrice,
      );

      if (riskResult.allowed) {
        finalSignals.push(sig);
      } else {
        logger.warn(
          `[风险拦截] 信号被风险控制拦截：${sigName}(${normalizedSigSymbol}) ${sig.action} - ${riskResult.reason}`,
        );
      }
    }

    return finalSignals;
  };

  return {
    processSellSignals,
    applyRiskChecks,
  };
};


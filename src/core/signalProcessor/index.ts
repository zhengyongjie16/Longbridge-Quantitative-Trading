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
 * - 智能平仓开启：仅卖出盈利订单
 * - 智能平仓关闭：清空所有持仓
 * - 无符合条件订单：信号设为 HOLD
 */

import { logger } from '../../utils/logger/index.js';
import { getDirectionName, formatSymbolDisplayFromQuote, formatError } from '../../utils/helpers/index.js';
import {
  getSymbolName,
  buildSellReason,
  validateSellContext,
  resolveSellQuantityByFullClose,
  resolveSellQuantityBySmartClose,
} from './utils.js';
import { VERIFICATION } from '../../constants/index.js';
import type {
  Quote,
  Position,
  Signal,
  OrderRecorder,
  AccountSnapshot,
  RiskCheckContext,
} from '../../types/index.js';
import type { SellQuantityResult, SignalProcessor, SignalProcessorDeps } from './types.js';

/**
 * 计算卖出信号的数量和原因
 * 智能平仓开启：仅卖出盈利订单；关闭：清仓所有持仓
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
  const validationResult = validateSellContext(position, quote);
  if (!validationResult.valid) {
    return {
      quantity: null,
      shouldHold: true,
      reason: buildSellReason(reason, validationResult.reason),
    };
  }

  const { currentPrice, availableQuantity } = validationResult;

  // 智能平仓关闭：直接清仓所有持仓
  if (!smartCloseEnabled) {
    const fullCloseResult = resolveSellQuantityByFullClose({
      availableQuantity,
      directionName,
    });
    return {
      ...fullCloseResult,
      reason: buildSellReason(reason, fullCloseResult.reason),
    };
  }

  // 智能平仓开启：仅卖出盈利订单
  const smartCloseResult = resolveSellQuantityBySmartClose({
    orderRecorder,
    currentPrice,
    availableQuantity,
    direction,
    symbol,
  });

  return {
    ...smartCloseResult,
    reason: buildSellReason(reason, smartCloseResult.reason),
  };
}

function isBuyAction(action: Signal['action']): boolean {
  return action === 'BUYCALL' || action === 'BUYPUT';
}

function getRiskCheckCooldownKey(symbol: string, action: Signal['action']): string {
  if (isBuyAction(action)) {
    return `${symbol}_BUY`;
  }

  return `${symbol}_SELL`;
}

/** 创建信号处理器（工厂函数） */
export const createSignalProcessor = ({
  tradingConfig,
  liquidationCooldownTracker,
}: SignalProcessorDeps): SignalProcessor => {
  /** 冷却时间记录：Map<symbol_direction, timestamp>，防止重复信号频繁触发风险检查 */
  const lastRiskCheckTime = new Map<string, number>();

  /** 处理卖出信号，计算智能平仓数量 */
  const processSellSignals = (
    signals: Signal[],
    longPosition: Position | null,
    shortPosition: Position | null,
    longQuote: Quote | null,
    shortQuote: Quote | null,
    orderRecorder: OrderRecorder,
    smartCloseEnabled: boolean,
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

      // 检查是否是末日保护程序的清仓信号（无条件清仓，不受智能平仓影响）
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
      if (position && quote && Number.isFinite(position.availableQuantity) && Number.isFinite(quote.price)) {
        logger.info(
          `[卖出信号处理] ${signalName}: 当前价格=${quote.price.toFixed(3)}, 可用数量=${
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
        // 正常卖出信号：根据智能平仓配置进行数量计算
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

  /** 对信号列表应用风险检查，过滤不符合条件的信号 */
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

    // 步骤1：在 API 调用之前先过滤冷却期内的信号
    // 这样可以避免所有买入信号都在冷却期内时的无效 API 调用
    const now = Date.now();
    const cooldownMs = VERIFICATION.VERIFIED_SIGNAL_COOLDOWN_SECONDS * 1000;
    const signalsAfterCooldown: Signal[] = [];

    for (const sig of signals) {
      const sigSymbol = sig.symbol;
      const cooldownKey = getRiskCheckCooldownKey(sigSymbol, sig.action);
      const lastTime = lastRiskCheckTime.get(cooldownKey);

      if (lastTime && now - lastTime < cooldownMs) {
        const remainingSeconds = Math.ceil((lastTime + cooldownMs - now) / 1000);
        const reason = `风险检查冷却期内，剩余 ${remainingSeconds} 秒`;
        sig.reason = reason;
        const sigName = getSymbolName(
          sig.symbol,
          longSymbol,
          shortSymbol,
          longSymbolName,
          shortSymbolName,
        );
        logger.debug(
          `[验证冷却] ${sigName}(${sigSymbol}) ${sig.action} 在冷却期内，剩余 ${remainingSeconds} 秒，跳过风险检查`,
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
    const hasBuySignals = signalsAfterCooldown.some((signal) => isBuyAction(signal.action));

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
      const sigSymbol = sig.symbol;
      const sigName = getSymbolName(
        sig.symbol,
        longSymbol,
        shortSymbol,
        longSymbolName,
        shortSymbolName,
      );
      const signalLabel = `${sigName}(${sigSymbol}) ${sig.action}`;

      // 标记进入风险检查的时间（在处理信号前标记，确保后续相同信号被冷却）
      const cooldownKey = getRiskCheckCooldownKey(sigSymbol, sig.action);
      lastRiskCheckTime.set(cooldownKey, now);

      // 获取标的的当前价格用于计算持仓市值
      let currentPrice: number | null = null;
      if (sigSymbol === longSymbol && longQuote) {
        currentPrice = longQuote.price;
      } else if (sigSymbol === shortSymbol && shortQuote) {
        currentPrice = shortQuote.price;
      }

      // 检查是否是买入操作
      const isBuyActionCheck = isBuyAction(sig.action);

      if (isBuyActionCheck) {
        if (buyApiFetchFailed) {
          const reason = '批量获取账户和持仓信息失败，买入信号被拒绝';
          sig.reason = reason;
          logger.warn(
            `[风险检查] ${reason}：${signalLabel}`,
          );
          continue;
        }

        const isLongBuyAction = sig.action === 'BUYCALL';
        const directionDesc = isLongBuyAction ? '做多标的' : '做空标的';

        // 买入操作检查顺序：
        // 1. 交易频率限制
        // 2. 买入价格限制
        // 3. 末日保护程序
        // 4. 牛熊证风险
        // 5. 基础风险检查

        // 1. 检查交易频率限制
        const tradeCheck = trader._canTradeNow(sig.action, context.config);
        if (!tradeCheck.canTrade) {
          const waitSeconds = tradeCheck.waitSeconds ?? 0;
          const reason = `交易频率限制：${directionDesc} 在${context.config.buyIntervalSeconds}秒内已买入过，需等待 ${waitSeconds} 秒后才能再次买入`;
          sig.reason = reason;
          logger.warn(
            `[交易频率限制] ${reason}：${signalLabel}`,
          );
          continue;
        }

        // 保护性清仓冷却：拦截冷却时间内的买入
        const liquidationDirection = isLongBuyAction ? 'LONG' : 'SHORT';
        const remainingMs = liquidationCooldownTracker.getRemainingMs({
          symbol: sig.symbol,
          direction: liquidationDirection,
          cooldownConfig: context.config.liquidationCooldown,
        });
        if (remainingMs > 0) {
          const remainingSeconds = Math.ceil(remainingMs / 1000);
          const reason = `清仓冷却期内，剩余 ${remainingSeconds} 秒，拒绝买入`;
          sig.reason = reason;
          logger.warn(
            `[清仓冷却] ${signalLabel} ${reason}`,
          );
          continue;
        }

        // 频率检查通过后立即标记买入意图（预占时间槽）
        // 防止同一批次中的多个延迟验证信号同时通过频率检查
        trader._markBuyAttempt(sig.action, context.config);

        // 2. 买入价格限制
        const latestBuyPrice = orderRecorder.getLatestBuyOrderPrice(sigSymbol, isLongBuyAction);

        if (latestBuyPrice !== null && currentPrice !== null) {
          const currentPriceStr = currentPrice.toFixed(3);
          const latestBuyPriceStr = latestBuyPrice.toFixed(3);

          if (currentPrice > latestBuyPrice) {
            const reason = `买入价格限制：当前价格 ${currentPriceStr} 高于最新买入订单价格 ${latestBuyPriceStr}`;
            sig.reason = reason;
            logger.warn(
              `[买入价格限制] ${directionDesc} 当前价格 ${currentPriceStr} 高于最新买入订单价格 ${latestBuyPriceStr}，拒绝买入：${signalLabel}`,
            );
            continue;
          }
          logger.info(
            `[买入价格限制] ${directionDesc} 当前价格 ${currentPriceStr} 低于或等于最新买入订单价格 ${latestBuyPriceStr}，允许买入：${signalLabel}`,
          );
        }

        // 3. 末日保护程序：收盘前15分钟拒绝买入
        if (
          tradingConfig.global.doomsdayProtection &&
          doomsdayProtection.shouldRejectBuy(currentTime, isHalfDay)
        ) {
          const closeTimeRange = isHalfDay ? '11:45-12:00' : '15:45-16:00';
          const reason = `末日保护程序：收盘前15分钟内拒绝买入（当前时间在${closeTimeRange}范围内）`;
          sig.reason = reason;
          logger.warn(
            `[末日保护程序] ${reason}：${signalLabel}`,
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
          currentPrice,
        );

        if (!warrantRiskResult.allowed) {
          const reason = warrantRiskResult.reason ?? '牛熊证风险检查未通过';
          sig.reason = reason;
          logger.warn(
            `[牛熊证风险拦截] 信号被牛熊证风险控制拦截：${signalLabel} - ${reason}`,
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

          if (sigSymbol === longSymbol) {
            quoteForSymbol = longQuote;
          } else if (sigSymbol === shortSymbol) {
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
        const reason = '买入操作无法获取账户信息，买入信号被拒绝';
        sig.reason = reason;
        logger.warn(
          `[风险检查] ${reason}：${signalLabel}`,
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
        const reason = riskResult.reason ?? '基础风险检查未通过';
        sig.reason = reason;
        logger.warn(
          `[风险拦截] 信号被风险控制拦截：${signalLabel} - ${reason}`,
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


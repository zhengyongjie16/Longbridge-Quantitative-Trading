/**
 * 信号处理模块 - 买入风险检查流水线
 *
 * 功能：
 * - 执行买入信号风险检查并过滤无效信号
 * - 维护风险检查冷却与交易频率控制
 * - 处理风控数据源切换（买入实时/卖出缓存）
 */
import { logger } from '../../utils/logger/index.js';
import {
  formatSymbolDisplayFromQuote,
  formatError,
  isBuyAction,
} from '../../utils/helpers/index.js';
import { VERIFICATION } from '../../constants/index.js';
import { getSymbolName } from './utils.js';
import type { AccountSnapshot, Position } from '../../types/account.js';
import type { Quote } from '../../types/quote.js';
import type { Signal } from '../../types/signal.js';
import type { MultiMonitorTradingConfig } from '../../types/config.js';
import type { RiskCheckContext } from '../../types/services.js';
import type { LiquidationCooldownTracker } from '../../services/liquidationCooldown/types.js';

/** 生成风险检查冷却 Map 的键，按标的和买卖方向区分 */
function getRiskCheckCooldownKey(symbol: string, action: Signal['action']): string {
  if (isBuyAction(action)) {
    return `${symbol}_BUY`;
  }

  return `${symbol}_SELL`;
}

/**
 * 创建买入风险检查流水线
 * 返回一个异步函数，对信号列表依次执行冷却过滤、API 数据获取、买入专项检查（频率/冷却/价格/末日保护/牛熊证）
 * 和基础风险检查，过滤掉不符合条件的信号后返回通过的信号列表
 */
export const createRiskCheckPipeline = ({
  tradingConfig,
  liquidationCooldownTracker,
  lastRiskCheckTime,
}: {
  readonly tradingConfig: MultiMonitorTradingConfig;
  readonly liquidationCooldownTracker: LiquidationCooldownTracker;
  readonly lastRiskCheckTime: Map<string, number>;
}): ((signals: Signal[], context: RiskCheckContext) => Promise<Signal[]>) => {
  /** 对信号列表应用风险检查，过滤不符合条件的信号 */
  const applyRiskChecks = async (
    signals: Signal[],
    context: RiskCheckContext,
  ): Promise<Signal[]> => {
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

    // 在 API 调用之前先过滤冷却期内的信号
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

    // 检查过滤后是否有买入信号，决定是否调用 API
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
        logger.warn('[风险检查] 批量获取账户和持仓信息失败，买入信号将被拒绝', formatError(err));
        buyApiFetchFailed = true;
      }
    }

    const finalSignals: Signal[] = [];

    // 遍历过滤后的信号进行风险检查
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
          logger.warn(`[风险检查] ${reason}：${signalLabel}`);
          continue;
        }

        const isLongBuyAction = sig.action === 'BUYCALL';
        const directionDesc = isLongBuyAction ? '做多标的' : '做空标的';

        /**
         * 买入风险检查流水线执行顺序及原因：
         *
         * 1. 交易频率限制（轻量）：仅检查内存中的时间戳，无 API 调用
         * 2. 清仓冷却（中量）：检查冷却追踪器
         * 3. 买入价格限制（轻量）：比较当前价与最近买入价
         * 4. 末日保护程序（轻量）：检查时间是否在保护期内
         * 5. 牛熊证风险（中量）：计算距回收价百分比
         * 6. 基础风险检查（重量）：调用 API 获取账户和持仓数据
         *
         * 排序原则：先轻量后重量，减少不必要的 API 调用
         */
        // 1. 检查交易频率限制
        const tradeCheck = trader.canTradeNow(sig.action, context.config);
        if (!tradeCheck.canTrade) {
          const waitSeconds = tradeCheck.waitSeconds ?? 0;
          const reason = `交易频率限制：${directionDesc} 在${context.config.buyIntervalSeconds}秒内已买入过，需等待 ${waitSeconds} 秒后才能再次买入`;
          sig.reason = reason;
          logger.warn(`[交易频率限制] ${reason}：${signalLabel}`);
          continue;
        }

        // 保护性清仓冷却：拦截冷却时间内的买入
        const liquidationDirection = isLongBuyAction ? 'LONG' : 'SHORT';
        const remainingMs = liquidationCooldownTracker.getRemainingMs({
          symbol: context.config.monitorSymbol,
          direction: liquidationDirection,
          cooldownConfig: context.config.liquidationCooldown,
        });
        if (remainingMs > 0) {
          const remainingSeconds = Math.ceil(remainingMs / 1000);
          const reason = `清仓冷却期内，剩余 ${remainingSeconds} 秒，拒绝买入`;
          sig.reason = reason;
          logger.warn(`[清仓冷却] ${signalLabel} ${reason}`);
          continue;
        }

        // 频率检查通过后立即标记买入意图（预占时间槽）
        // 防止同一批次中的多个延迟验证信号同时通过频率检查
        trader.recordBuyAttempt(sig.action, context.config);

        // 3. 买入价格限制
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

        // 4. 末日保护程序：收盘前15分钟拒绝买入
        if (
          tradingConfig.global.doomsdayProtection &&
          doomsdayProtection.shouldRejectBuy(currentTime, isHalfDay)
        ) {
          const closeTimeRange = isHalfDay ? '11:45-12:00' : '15:45-16:00';
          const reason = `末日保护程序：收盘前15分钟内拒绝买入（当前时间在${closeTimeRange}范围内）`;
          sig.reason = reason;
          logger.warn(`[末日保护程序] ${reason}：${signalLabel}`);
          continue;
        }

        // 5. 检查牛熊证风险
        const monitorCurrentPrice = monitorQuote?.price ?? monitorSnapshot?.price ?? null;

        const warrantRiskResult = riskChecker.checkWarrantRisk(
          sig.symbol,
          sig.action,
          monitorCurrentPrice ?? 0,
          currentPrice,
        );

        if (warrantRiskResult.allowed) {
          if (warrantRiskResult.warrantInfo?.isWarrant) {
            const warrantType =
              warrantRiskResult.warrantInfo.warrantType === 'BULL' ? '牛证' : '熊证';
            const distancePercent = warrantRiskResult.warrantInfo.distanceToStrikePercent;

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
        } else {
          const reason = warrantRiskResult.reason ?? '牛熊证风险检查未通过';
          sig.reason = reason;
          logger.warn(`[牛熊证风险拦截] 信号被牛熊证风险控制拦截：${signalLabel} - ${reason}`);
          continue;
        }
      }

      // 6. 基础风险检查
      // 买入信号使用实时数据，卖出信号使用缓存数据
      const accountForRiskCheck = isBuyActionCheck ? freshAccount : context.account;
      const positionsForRiskCheck = isBuyActionCheck ? freshPositions : (context.positions ?? []);

      if (isBuyActionCheck && accountForRiskCheck === null) {
        const reason = '买入操作无法获取账户信息，买入信号被拒绝';
        sig.reason = reason;
        logger.warn(`[风险检查] ${reason}：${signalLabel}`);
        continue;
      }

      // 使用选择的数据进行风险检查
      const orderNotional = context.config.targetNotional ?? 0;
      const longCurrentPrice = longQuote?.price ?? null;
      const shortCurrentPrice = shortQuote?.price ?? null;
      const riskResult = riskChecker.checkBeforeOrder({
        account: accountForRiskCheck,
        positions: positionsForRiskCheck,
        signal: sig,
        orderNotional,
        currentPrice,
        longCurrentPrice,
        shortCurrentPrice,
      });

      if (riskResult.allowed) {
        finalSignals.push(sig);
      } else {
        const reason = riskResult.reason ?? '基础风险检查未通过';
        sig.reason = reason;
        logger.warn(`[风险拦截] 信号被风险控制拦截：${signalLabel} - ${reason}`);
      }
    }

    return finalSignals;
  };

  return applyRiskChecks;
};

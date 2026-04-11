/**
 * 信号处理模块 - 风险检查流水线
 *
 * 功能：
 * - 执行信号风险检查并过滤无效信号
 * - 维护风险检查冷却与交易频率控制
 * - 买入在轻检查通过后实时拉取账户/持仓，卖出使用上下文缓存数据
 */
import { logger } from '../../utils/logger/index.js';
import { isBuyAction } from '../../utils/helpers/index.js';
import { formatSymbolDisplayFromQuote } from '../utils.js';
import { VERIFICATION } from '../../constants/index.js';
import { getDoomsdayBuyCutoffWindowRangeLabel } from '../doomsdayProtection/utils.js';
import { getSymbolName } from './utils.js';
import type { Quote } from '../../types/quote.js';
import type { Signal } from '../../types/signal.js';
import type { LiquidationCooldownConfig, MultiMonitorTradingConfig } from '../../types/config.js';
import type { RiskCheckContext } from '../../types/services.js';
import type { LiquidationCooldownTracker } from '../../services/liquidationCooldown/types.js';
import { formatError } from '../../utils/error/index.js';

/** 生成风险检查冷却 Map 的键，按标的和买卖方向区分 */
function getRiskCheckCooldownKey(symbol: string, action: Signal['action']): string {
  if (isBuyAction(action)) {
    return `${symbol}_BUY`;
  }

  return `${symbol}_SELL`;
}

function getMonitorCooldownRemainingMs(params: {
  readonly liquidationCooldownTracker: LiquidationCooldownTracker;
  readonly monitorSymbol: string;
  readonly cooldownConfig: LiquidationCooldownConfig | null;
  readonly currentTimeMs: number;
}): number {
  const { liquidationCooldownTracker, monitorSymbol, cooldownConfig, currentTimeMs } = params;
  const longRemainingMs = liquidationCooldownTracker.getRemainingMs({
    symbol: monitorSymbol,
    direction: 'LONG',
    cooldownConfig,
    currentTimeMs,
  });
  const shortRemainingMs = liquidationCooldownTracker.getRemainingMs({
    symbol: monitorSymbol,
    direction: 'SHORT',
    cooldownConfig,
    currentTimeMs,
  });

  return Math.max(longRemainingMs, shortRemainingMs);
}

function getSignalQuote(params: {
  readonly signalSymbol: string;
  readonly longSymbol: string;
  readonly shortSymbol: string;
  readonly longQuote: Quote | null;
  readonly shortQuote: Quote | null;
}): Quote | null {
  const { signalSymbol, longSymbol, shortSymbol, longQuote, shortQuote } = params;
  if (signalSymbol === longSymbol) {
    return longQuote;
  }

  if (signalSymbol === shortSymbol) {
    return shortQuote;
  }

  return null;
}

/**
 * 创建风险检查流水线
 * 返回一个异步函数：先做统一冷却过滤，再按买卖路径执行风控。
 * 买入路径固定为轻检查通过后实时拉取账户/持仓并执行基础风险检查；
 * 卖出路径直接使用上下文缓存账户/持仓执行基础风险检查。
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

    // 在本次调用入口固定当前毫秒时间，供冷却过滤/冷却写入/清仓冷却查询复用
    const currentTimeMs = Date.now();

    // 先过滤风险检查冷却期信号
    // 这样可以避免冷却期内信号进入后续检查与实时数据拉取
    const cooldownMs = VERIFICATION.VERIFIED_SIGNAL_COOLDOWN_SECONDS * 1000;
    const signalsAfterCooldown: Signal[] = [];
    for (const sig of signals) {
      const sigSymbol = sig.symbol;
      const cooldownKey = getRiskCheckCooldownKey(sigSymbol, sig.action);
      const lastTime = lastRiskCheckTime.get(cooldownKey);
      if (lastTime && currentTimeMs - lastTime < cooldownMs) {
        const remainingSeconds = Math.ceil((lastTime + cooldownMs - currentTimeMs) / 1000);
        const reason = `风险检查冷却期内，剩余 ${remainingSeconds} 秒`;
        sig.reason = reason;
      } else {
        signalsAfterCooldown.push(sig);
      }
    }

    // 如果所有信号都被冷却拦截，直接返回空数组
    if (signalsAfterCooldown.length === 0) {
      return [];
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
      lastRiskCheckTime.set(cooldownKey, currentTimeMs);

      const signalQuote = getSignalQuote({
        signalSymbol: sigSymbol,
        longSymbol,
        shortSymbol,
        longQuote,
        shortQuote,
      });
      const currentPrice = signalQuote?.price ?? null;

      // 买入路径：冷却已在循环前处理，这里按固定顺序执行轻检查后再实时拉取风控数据
      if (isBuyAction(sig.action)) {
        const isLongBuyAction = sig.action === 'BUYCALL';
        const directionDesc = isLongBuyAction ? '做多标的' : '做空标的';

        /**
         * 买入风险检查流水线顺序（固定）：
         * 1. 风险检查冷却（已在循环前完成）
         * 2. 交易频率限制
         * 3. 清仓冷却
         * 4. 买入价格限制
         * 5. 末日保护程序
         * 6. 牛熊证风险
         * 7. Promise.all([trader.getAccountSnapshot(), trader.getStockPositions()])
         * 8. 基础风险检查（使用第 7 步实时数据）
         */
        const tradeCheck = trader.canTradeNow(sig.action, context.config);
        if (!tradeCheck.canTrade) {
          const waitSeconds = tradeCheck.waitSeconds ?? 0;
          const reason = `交易频率限制：${directionDesc} 在${context.config.buyIntervalSeconds}秒内已买入过，需等待 ${waitSeconds} 秒后才能再次买入`;
          sig.reason = reason;
          logger.warn(`[交易频率限制] ${reason}：${signalLabel}`);
          continue;
        }

        const remainingMs = getMonitorCooldownRemainingMs({
          liquidationCooldownTracker,
          monitorSymbol: context.config.monitorSymbol,
          cooldownConfig: context.config.liquidationCooldown,
          currentTimeMs,
        });
        if (remainingMs > 0) {
          const remainingSeconds = Math.ceil(remainingMs / 1000);
          const reason = `清仓冷却期内，剩余 ${remainingSeconds} 秒，拒绝买入`;
          sig.reason = reason;
          logger.warn(`[清仓冷却] ${signalLabel} ${reason}`);
          continue;
        }

        const latestBuyPrice = orderRecorder.getLatestBuyOrderPrice(sigSymbol, isLongBuyAction);
        if (latestBuyPrice !== null && currentPrice !== null) {
          const currentPriceStr = currentPrice.toFixed(3);
          const latestBuyPriceStr = latestBuyPrice.toFixed(3);
          if (currentPrice >= latestBuyPrice) {
            const reason = `买入价格限制：当前价格 ${currentPriceStr} 高于或等于最新买入订单价格 ${latestBuyPriceStr}`;
            sig.reason = reason;
            logger.warn(
              `[买入价格限制] ${directionDesc} 当前价格 ${currentPriceStr} 高于或等于最新买入订单价格 ${latestBuyPriceStr}，拒绝买入：${signalLabel}`,
            );
            continue;
          }

          logger.debug(
            `[买入价格限制] ${directionDesc} 当前价格 ${currentPriceStr} 低于最新买入订单价格 ${latestBuyPriceStr}，允许买入：${signalLabel}`,
          );
        }

        if (
          tradingConfig.global.doomsdayProtection &&
          doomsdayProtection.isBuyCutoffWindowActive(currentTime, isHalfDay)
        ) {
          const closeTimeRange = getDoomsdayBuyCutoffWindowRangeLabel(isHalfDay);
          const reason = `末日保护程序：买入截止窗口内拒绝买入（当前时间在${closeTimeRange}范围内）`;
          sig.reason = reason;
          logger.warn(`[末日保护程序] ${reason}：${signalLabel}`);
          continue;
        }

        const monitorCurrentPrice = monitorQuote?.price ?? monitorSnapshot?.price ?? null;
        const warrantRiskResult = riskChecker.checkWarrantRisk(
          sig.symbol,
          sig.action,
          monitorCurrentPrice ?? 0,
        );
        if (warrantRiskResult.allowed) {
          if (warrantRiskResult.warrantInfo?.isWarrant) {
            const warrantType =
              warrantRiskResult.warrantInfo.warrantType === 'BULL' ? '牛证' : '熊证';
            const distancePercent = warrantRiskResult.warrantInfo.distanceToStrikePercent;

            const symbolDisplay = formatSymbolDisplayFromQuote(signalQuote, sig.symbol);
            logger.debug(
              `[牛熊证风险检查] ${symbolDisplay} 为${warrantType}，距离回收价百分比：${distancePercent.toFixed(
                2,
              )}%，风险检查通过`,
            );
          }
        } else {
          const reason = warrantRiskResult.reason ?? '牛熊证风险检查未通过';
          sig.reason = reason;
          logger.warn(`[牛熊证风险拦截] 信号被牛熊证风险控制拦截：${signalLabel} - ${reason}`);
          continue;
        }

        let realtimeAccount: Awaited<ReturnType<typeof trader.getAccountSnapshot>>;
        let realtimePositions: Awaited<ReturnType<typeof trader.getStockPositions>>;
        try {
          [realtimeAccount, realtimePositions] = await Promise.all([
            trader.getAccountSnapshot(),
            trader.getStockPositions(),
          ]);
        } catch (err) {
          const reason = '获取实时账户和持仓信息失败，买入信号被拒绝';
          sig.reason = reason;
          logger.warn(`[风险检查] ${reason}：${signalLabel}`, formatError(err));
          continue;
        }

        if (realtimeAccount === null) {
          const reason = '买入操作无法获取账户信息，买入信号被拒绝';
          sig.reason = reason;
          logger.warn(`[风险检查] ${reason}：${signalLabel}`);
          continue;
        }

        const orderNotional = context.config.targetNotional;
        const buyRiskResult = riskChecker.checkBeforeOrder({
          account: realtimeAccount,
          positions: realtimePositions,
          signal: sig,
          orderNotional,
          currentPrice,
        });
        if (buyRiskResult.allowed) {
          finalSignals.push(sig);
        } else {
          const reason = buyRiskResult.reason ?? '基础风险检查未通过';
          sig.reason = reason;
          logger.warn(`[风险拦截] 信号被风险控制拦截：${signalLabel} - ${reason}`);
        }

        continue;
      }

      // 卖出路径基础风险检查使用上下文缓存数据
      const orderNotional = context.config.targetNotional;
      const sellRiskResult = riskChecker.checkBeforeOrder({
        account: context.account,
        positions: context.positions,
        signal: sig,
        orderNotional,
        currentPrice,
      });
      if (sellRiskResult.allowed) {
        finalSignals.push(sig);
      } else {
        const reason = sellRiskResult.reason ?? '基础风险检查未通过';
        sig.reason = reason;
        logger.warn(`[风险拦截] 信号被风险控制拦截：${signalLabel} - ${reason}`);
      }
    }

    return finalSignals;
  };
  return applyRiskChecks;
};

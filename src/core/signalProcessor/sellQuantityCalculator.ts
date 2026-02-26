/**
 * 信号处理模块 - 卖出数量计算与智能平仓
 *
 * 功能：
 * - 计算卖出信号数量并生成原因说明
 * - 支持智能平仓与全仓清仓
 * - 处理末日保护无条件清仓
 *
 * 卖出委托价规则（业务约束）：
 * - 限价/增强限价卖单的委托价必须以「执行时行情」为准，不能使用信号生成时的快照价。
 * - 本模块在决定卖出时使用当前 quote，并写回 signal.price，确保 orderExecutor 提交时用的是执行时价格。
 */
import { logger } from '../../utils/logger/index.js';
import {
  getLongDirectionName,
  getShortDirectionName,
  isSellAction,
} from '../../utils/helpers/index.js';
import {
  buildSellReason,
  validateSellContext,
  resolveSellQuantityByFullClose,
  resolveSellQuantityBySmartClose,
} from './utils.js';
import type { Position } from '../../types/account.js';
import type { Quote } from '../../types/quote.js';
import type { OrderRecorder } from '../../types/services.js';
import type { ProcessSellSignalsParams } from './types.js';
import type { TradingCalendarSnapshot } from '../../types/tradingCalendar.js';

/**
 * 计算卖出信号的数量和原因
 * 智能平仓开启：按三阶段规则计算；关闭：清仓所有持仓
 * @param params 卖出数量计算参数（持仓、行情、方向、配置与时间快照）
 * @returns 包含卖出数量、是否持有、原因说明及关联买入订单ID列表的结果
 */
function calculateSellQuantity(params: {
  readonly position: Position | null;
  readonly quote: Quote | null;
  readonly orderRecorder: OrderRecorder | null;
  readonly direction: 'LONG' | 'SHORT';
  readonly originalReason: string;
  readonly smartCloseEnabled: boolean;
  readonly symbol: string;
  readonly smartCloseTimeoutMinutes: number | null;
  readonly nowMs: number;
  readonly isHalfDay: boolean;
  readonly tradingCalendarSnapshot: TradingCalendarSnapshot;
}): {
  quantity: number | null;
  shouldHold: boolean;
  reason: string;
  relatedBuyOrderIds: readonly string[];
} {
  const {
    position,
    quote,
    orderRecorder,
    direction,
    originalReason,
    smartCloseEnabled,
    symbol,
    smartCloseTimeoutMinutes,
    nowMs,
    isHalfDay,
    tradingCalendarSnapshot,
  } = params;

  const reason = originalReason || '';
  const directionName = direction === 'LONG' ? getLongDirectionName() : getShortDirectionName();

  // 验证输入参数
  const validationResult = validateSellContext(position, quote);
  if (!validationResult.valid) {
    return {
      quantity: null,
      shouldHold: true,
      reason: buildSellReason(reason, validationResult.reason),
      relatedBuyOrderIds: [],
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

  // 智能平仓开启：按三阶段规则计算卖出数量（防重版本）
  const smartCloseResult = resolveSellQuantityBySmartClose({
    orderRecorder,
    currentPrice,
    availableQuantity,
    direction,
    symbol,
    smartCloseTimeoutMinutes,
    nowMs,
    isHalfDay,
    tradingCalendarSnapshot,
  });

  return {
    ...smartCloseResult,
    reason: buildSellReason(reason, smartCloseResult.reason),
  };
}

/**
 * 处理卖出信号，计算实际卖出数量并写回信号对象
 *
 * 遍历信号列表，对每个卖出信号（SELLCALL/SELLPUT）根据智能平仓配置计算数量。
 * 末日保护信号无条件清仓，不受智能平仓影响。
 * 委托价以执行时行情为准，覆盖信号生成时的快照价，确保提交时价格准确。
 *
 * @param params 卖出信号处理参数（行情、持仓、配置与时间快照）
 * @returns 处理后的信号列表（与入参为同一引用）
 */
export const processSellSignals = (
  params: ProcessSellSignalsParams,
): ProcessSellSignalsParams['signals'] => {
  const {
    signals,
    longPosition,
    shortPosition,
    longQuote,
    shortQuote,
    orderRecorder,
    smartCloseEnabled,
    smartCloseTimeoutMinutes,
    nowMs,
    isHalfDay,
    tradingCalendarSnapshot,
  } = params;

  for (const sig of signals) {
    // 只处理卖出信号（SELLCALL 和 SELLPUT），跳过买入信号
    if (!isSellAction(sig.action)) {
      continue;
    }

    // 根据信号类型确定对应的持仓和行情
    const isLongSignal = sig.action === 'SELLCALL';
    const position = isLongSignal ? longPosition : shortPosition;
    const quote = isLongSignal ? longQuote : shortQuote;
    const direction: 'LONG' | 'SHORT' = isLongSignal ? 'LONG' : 'SHORT';
    const directionName = isLongSignal ? '做多' : '做空';
    const signalName = isLongSignal ? 'SELLCALL' : 'SELLPUT';

    // 检查是否是末日保护程序的清仓信号（无条件清仓，不受智能平仓影响）
    const isDoomsdaySignal = sig.reason?.includes('末日保护程序');

    // 持仓或行情缺失时记录日志
    if (!position) {
      logger.warn(
        `[卖出信号处理] ${signalName}: ${directionName}标的持仓对象为null，无法计算卖出数量`,
      );
    }
    if (!quote) {
      logger.warn(
        `[卖出信号处理] ${signalName}: ${directionName}标的行情数据为null，无法计算卖出数量`,
      );
    }
    if (
      position &&
      quote &&
      Number.isFinite(position.availableQuantity) &&
      Number.isFinite(quote.price)
    ) {
      logger.info(
        `[卖出信号处理] ${signalName}: 当前价格=${quote.price.toFixed(3)}, 可用数量=${position.availableQuantity}`,
      );
    }

    if (isDoomsdaySignal) {
      // 末日保护程序：无条件清仓，使用全部可用数量
      if (position && position.availableQuantity > 0) {
        sig.quantity = position.availableQuantity;
        // 委托价必须以执行时行情为准，覆盖流水线可能写入的旧价
        if (quote?.price !== undefined) {
          sig.price = quote.price;
        }
        if (quote?.lotSize !== undefined) {
          sig.lotSize = quote.lotSize;
        }
        logger.info(`[卖出信号处理] ${signalName}(末日保护): 无条件清仓，卖出数量=${sig.quantity}`);
      } else {
        logger.warn(`[卖出信号处理] ${signalName}(末日保护): 持仓对象无效，无法清仓`);
        sig.action = 'HOLD';
        sig.reason = `${sig.reason}，但持仓对象无效`;
      }
    } else {
      // 正常卖出信号：根据智能平仓配置进行数量计算
      // 传入 sig.symbol 以精确筛选订单记录（多标的支持）
      const result = calculateSellQuantity({
        position,
        quote,
        orderRecorder,
        direction,
        originalReason: sig.reason ?? '',
        smartCloseEnabled,
        symbol: sig.symbol,
        smartCloseTimeoutMinutes,
        nowMs,
        isHalfDay,
        tradingCalendarSnapshot,
      });
      if (result.shouldHold) {
        logger.info(`[卖出信号处理] ${signalName}被跳过: ${result.reason}`);
        sig.action = 'HOLD';
        sig.reason = result.reason;
        sig.relatedBuyOrderIds = null;
      } else {
        logger.info(
          `[卖出信号处理] ${signalName}通过: 卖出数量=${result.quantity}, 原因=${result.reason}`,
        );
        sig.quantity = result.quantity;
        sig.reason = result.reason;
        // 设置关联的买入订单ID列表（用于防重追踪）
        sig.relatedBuyOrderIds = result.relatedBuyOrderIds;
        // 委托价必须以执行时行情为准，覆盖流水线可能写入的旧价
        if (quote?.price !== undefined) {
          sig.price = quote.price;
        }
        if (quote?.lotSize !== undefined) {
          sig.lotSize = quote.lotSize;
        }
      }
    }
  }

  return signals;
};

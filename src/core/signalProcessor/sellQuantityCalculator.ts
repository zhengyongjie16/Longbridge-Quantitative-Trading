/**
 * 信号处理模块 - 卖出数量计算与智能平仓
 *
 * 功能：
 * - 计算卖出信号数量并生成原因说明
 * - 支持智能平仓与全仓清仓
 * - 处理末日保护无条件清仓
 */
import { logger } from '../../utils/logger/index.js';
import { getDirectionName } from '../../utils/helpers/index.js';
import {
  buildSellReason,
  validateSellContext,
  resolveSellQuantityByFullClose,
  resolveSellQuantityBySmartClose,
} from './utils.js';
import type { Quote, Position, Signal, OrderRecorder } from '../../types/index.js';
import type { SellQuantityResult } from './types.js';

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

/** 处理卖出信号，计算智能平仓数量 */
export const processSellSignals = (
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

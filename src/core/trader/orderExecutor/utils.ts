import { OrderSide, OrderType } from 'longport';
import { logger } from '../../../utils/logger/index.js';
import { SIGNAL_ACTION_DESCRIPTIONS } from '../../../constants/index.js';
import type { OrderTypeConfig, Signal } from '../../../types/signal.js';
import type { MonitorConfig } from '../../../types/config.js';
import type { OrderPayload } from '../types.js';
import { identifyErrorType } from '../tradeLogger.js';
import { formatError } from '../../../utils/error/index.js';
import { formatSymbolDisplay } from '../../../utils/display/index.js';
import { getHKDateKey } from '../../../utils/tradingTime/index.js';

/**
 * 获取信号动作的中文描述。
 *
 * @param signalAction 信号动作
 * @returns 对应动作描述文本
 */
export function getActionDescription(signalAction: Signal['action']): string {
  return SIGNAL_ACTION_DESCRIPTIONS[signalAction];
}

/**
 * 将配置中的订单类型字符串转换为 LongPort 订单类型枚举。
 * 默认行为：未知值回退为 ELO。
 *
 * @param typeConfig 订单类型配置
 * @returns LongPort 订单类型枚举
 */
export function getOrderTypeFromConfig(typeConfig: OrderTypeConfig): OrderType {
  switch (typeConfig) {
    case 'LO': {
      return OrderType.LO;
    }
    case 'ELO': {
      return OrderType.ELO;
    }
    case 'MO': {
      return OrderType.MO;
    }
    default: {
      return OrderType.ELO;
    }
  }
}

/**
 * 判断信号是否为跨日或无效触发时间的过期信号。
 * 默认行为：triggerTime 非法时判定为过期。
 *
 * @param signal 交易信号
 * @param now 当前时间
 * @returns true 表示过期，应跳过执行
 */
export function isStaleCrossDaySignal(signal: Signal, now: Date): boolean {
  if (!(signal.triggerTime instanceof Date) || Number.isNaN(signal.triggerTime.getTime())) {
    return true;
  }
  return getHKDateKey(signal.triggerTime) !== getHKDateKey(now);
}

/**
 * 判断信号是否为保护性清仓信号。
 *
 * @param signal 交易信号
 * @returns true 表示保护性清仓信号
 */
export function isLiquidationSignal(signal: Signal): boolean {
  return signal.isProtectiveLiquidation === true;
}

/**
 * 根据信号动作解析订单方向。
 * 默认行为：HOLD 或未知动作返回 null。
 *
 * @param action 信号动作
 * @returns 订单方向或 null
 */
export function resolveOrderSide(action: Signal['action']): OrderSide | null {
  switch (action) {
    case 'BUYCALL':
    case 'BUYPUT': {
      return OrderSide.Buy;
    }
    case 'SELLCALL':
    case 'SELLPUT': {
      return OrderSide.Sell;
    }
    case 'HOLD': {
      return null;
    }
    default: {
      return null;
    }
  }
}

/**
 * 构造买入频率限制键。
 * 默认行为：缺少 monitorSymbol 时仅按方向键区分。
 *
 * @param signalAction 信号动作
 * @param monitorConfig 监控配置
 * @returns 频率限制键
 */
export function buildBuyTimeKey(
  signalAction: string,
  monitorConfig?: MonitorConfig | null,
): string {
  const direction: 'LONG' | 'SHORT' = signalAction === 'BUYCALL' ? 'LONG' : 'SHORT';
  const monitorSymbol = monitorConfig?.monitorSymbol ?? '';
  return monitorSymbol ? `${monitorSymbol}:${direction}` : direction;
}

/**
 * 分类记录订单提交错误日志。
 *
 * @param err 原始错误对象
 * @param signal 交易信号
 * @param orderPayload 订单提交载荷
 * @returns 无返回值
 */
export function handleSubmitError(err: unknown, signal: Signal, orderPayload: OrderPayload): void {
  const actionDesc = getActionDescription(signal.action);
  const errorMessage = formatError(err);
  const errorType = identifyErrorType(errorMessage);
  const symbolDisplayForError = formatSymbolDisplay(orderPayload.symbol, signal.symbolName ?? null);
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

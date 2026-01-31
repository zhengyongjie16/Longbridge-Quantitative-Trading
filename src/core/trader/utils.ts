/**
 * 交易相关工具函数：订单类型展示与日志路径生成。
 */
import path from 'node:path';
import { OrderType } from 'longport';
import type { OrderTypeConfig, Signal } from '../../types/index.js';

type OrderTypeValue = typeof OrderType[keyof typeof OrderType];

// 订单类型到中文标签的映射
const orderTypeLabelMap: ReadonlyMap<OrderTypeValue, string> = new Map([
  [OrderType.LO, '限价单'],
  [OrderType.ELO, '增强限价单'],
  [OrderType.MO, '市价单'],
  [OrderType.ALO, '竞价限价单'],
  [OrderType.SLO, '特别限价单'],
]);

/**
 * 获取订单类型显示文本，未匹配时默认限价单。
 */
export const formatOrderTypeLabel = (orderType: OrderTypeValue): string => {
  return orderTypeLabelMap.get(orderType) ?? '限价单';
};

/**
 * 构造交易日志文件路径：logs/trades/YYYY-MM-DD.json
 */
export const buildTradeLogPath = (cwd: string, date: Date): string => {
  const dayKey = date.toISOString().split('T')[0];
  return path.join(cwd, 'logs', 'trades', `${dayKey}.json`);
};

type OrderTypeResolutionConfig = {
  readonly tradingOrderType: OrderTypeConfig;
  readonly liquidationOrderType: OrderTypeConfig;
};

/**
 * 订单类型解析优先级：
 * 1) 信号级覆盖 2) 保护性清仓 3) 全局交易类型
 */
export const resolveOrderTypeConfig = (
  signal: Pick<Signal, 'orderTypeOverride' | 'isProtectiveLiquidation'>,
  globalConfig: OrderTypeResolutionConfig,
): OrderTypeConfig => {
  if (signal.orderTypeOverride != null) {
    return signal.orderTypeOverride;
  }
  if (signal.isProtectiveLiquidation === true) {
    return globalConfig.liquidationOrderType;
  }
  return globalConfig.tradingOrderType;
};

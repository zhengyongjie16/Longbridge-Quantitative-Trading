import path from 'node:path';
import { OrderType } from 'longport';
import type { OrderTypeConfig, Signal } from '../../types/index.js';

type OrderTypeValue = typeof OrderType[keyof typeof OrderType];

const orderTypeLabelMap: ReadonlyMap<OrderTypeValue, string> = new Map([
  [OrderType.LO, '限价单'],
  [OrderType.ELO, '增强限价单'],
  [OrderType.MO, '市价单'],
  [OrderType.ALO, '竞价限价单'],
  [OrderType.SLO, '特别限价单'],
]);

export const formatOrderTypeLabel = (orderType: OrderTypeValue): string => {
  return orderTypeLabelMap.get(orderType) ?? '限价单';
};

export const buildTradeLogPath = (cwd: string, date: Date): string => {
  const dayKey = date.toISOString().split('T')[0];
  return path.join(cwd, 'logs', 'trades', `${dayKey}.json`);
};

type OrderTypeResolutionConfig = {
  readonly tradingOrderType: OrderTypeConfig;
  readonly liquidationOrderType: OrderTypeConfig;
};

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

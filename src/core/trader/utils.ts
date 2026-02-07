/**
 * 交易相关工具函数模块
 *
 * 功能：
 * - 订单类型展示：将 OrderType 枚举转换为中文标签
 * - 交易日志路径生成：构造按日期分文件的日志路径
 * - 订单类型解析：根据信号和配置解析订单类型
 *
 * 订单类型解析优先级：
 * 1. 信号级覆盖（signal.orderTypeOverride）
 * 2. 保护性清仓（signal.isProtectiveLiquidation === true）
 * 3. 全局交易类型（globalConfig.tradingOrderType）
 */
import path from 'node:path';
import { OrderType } from 'longport';
import type { OrderTypeConfig, Signal } from '../../types/index.js';
import type { OrderSubmitResponse } from './types.js';

const orderTypeLabelMap: ReadonlyMap<OrderType, string> = new Map([
  [OrderType.LO, '限价单'],
  [OrderType.ELO, '增强限价单'],
  [OrderType.MO, '市价单'],
  [OrderType.ALO, '竞价限价单'],
  [OrderType.SLO, '特别限价单'],
]);

const orderTypeCodeMap: ReadonlyMap<OrderType, string> = new Map([
  [OrderType.LO, 'LO'],
  [OrderType.ELO, 'ELO'],
  [OrderType.MO, 'MO'],
  [OrderType.ALO, 'ALO'],
  [OrderType.SLO, 'SLO'],
]);

/**
 * 获取订单类型显示文本，未匹配时默认限价单。
 */
export const formatOrderTypeLabel = (orderType: OrderType): string => {
  return orderTypeLabelMap.get(orderType) ?? '限价单';
};

/**
 * 获取订单类型代码（用于日志），未匹配时默认 SLO。
 */
export function getOrderTypeCode(orderType: OrderType): string {
  return orderTypeCodeMap.get(orderType) ?? 'SLO';
}

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

function isOrderSubmitResponse(value: unknown): value is OrderSubmitResponse {
  return typeof value === 'object' && value !== null && 'orderId' in value;
}

/**
 * 从订单提交 API 响应中安全提取订单 ID
 *
 * 优先顺序：orderId 字段 > toString() > 字符串值 > 兜底常量
 *
 * @param resp API 返回的任意值
 * @returns 订单 ID 字符串
 */
export function extractOrderId(resp: unknown): string {
  if (isOrderSubmitResponse(resp) && resp.orderId != null) {
    return String(resp.orderId);
  }
  // 信任边界：unknown 的 resp 可能具有 toString，需在运行时安全检查后访问
  const obj = resp as { toString?: () => unknown };
  if (typeof obj?.toString === 'function') {
    const str = obj.toString();
    if (typeof str === 'string') {
      return str;
    }
  }
  if (typeof resp === 'string') {
    return resp;
  }
  return 'UNKNOWN_ORDER_ID';
}

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

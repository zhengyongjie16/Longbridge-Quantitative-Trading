import path from 'node:path';
import { OrderType } from 'longport';
import { isValidPositiveNumber } from '../../utils/helpers/index.js';
import {
  NON_REPLACEABLE_ORDER_STATUSES,
  NON_REPLACEABLE_ORDER_TYPES,
} from '../../constants/index.js';
import type { OrderTypeConfig, Signal } from '../../types/signal.js';
import type {
  OrderSubmitResponse,
  OrderTypeResolutionConfig,
  PendingSellOrderSnapshot,
  SellMergeDecision,
  SellMergeDecisionInput,
} from './types.js';

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
 * 获取订单类型显示文本。
 * 默认行为：未匹配时返回「限价单」。
 *
 * @param orderType 订单类型枚举值
 * @returns 对应的中文标签字符串
 */
export function formatOrderTypeLabel(orderType: OrderType): string {
  return orderTypeLabelMap.get(orderType) ?? '限价单';
}

/**
 * 获取订单类型代码（用于日志）。
 * 默认行为：未匹配时返回 "SLO"。
 *
 * @param orderType 订单类型枚举值
 * @returns 对应的订单类型代码字符串（如 "LO"、"ELO"）
 */
export function getOrderTypeCode(orderType: OrderType): string {
  return orderTypeCodeMap.get(orderType) ?? 'SLO';
}

/**
 * 构造交易日志文件路径：logs/trades/YYYY-MM-DD.json
 * @param cwd 项目根目录（通常为 process.cwd()）
 * @param date 日志对应的日期
 * @returns 完整的日志文件绝对路径
 */
export function buildTradeLogPath(cwd: string, date: Date): string {
  const dayKey = date.toISOString().split('T')[0];
  return path.join(cwd, 'logs', 'trades', `${dayKey}.json`);
}

/**
 * 类型保护：检查值是否为 OrderSubmitResponse 类型
 * @param value 待检查的任意值
 * @returns true 表示值符合 OrderSubmitResponse 形状，同时收窄类型
 */
function isOrderSubmitResponse(value: unknown): value is OrderSubmitResponse {
  return typeof value === 'object' && value !== null && 'orderId' in value;
}

/**
 * 从订单提交 API 响应中安全提取订单 ID。
 *
 * 优先顺序：orderId 字段 > toString() > 字符串值 > 兜底常量
 *
 * @param resp API 返回的任意值
 * @returns 订单 ID 字符串，无法提取时返回 "UNKNOWN_ORDER_ID"
 */
export function extractOrderId(resp: unknown): string {
  if (isOrderSubmitResponse(resp) && resp.orderId !== undefined) {
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
 * 按优先级解析订单类型：信号级覆盖 → 保护性清仓类型 → 全局交易类型。
 * 默认行为：无覆盖且非保护性清仓时使用 globalConfig.tradingOrderType。
 *
 * @param signal 信号对象（取 orderTypeOverride 和 isProtectiveLiquidation 字段）
 * @param globalConfig 全局订单类型配置（含 tradingOrderType 和 liquidationOrderType）
 * @returns 解析后的订单类型配置
 */
export function resolveOrderTypeConfig(
  signal: Pick<Signal, 'orderTypeOverride' | 'isProtectiveLiquidation'>,
  globalConfig: OrderTypeResolutionConfig,
): OrderTypeConfig {
  if (signal.orderTypeOverride !== null && signal.orderTypeOverride !== undefined) {
    return signal.orderTypeOverride;
  }
  if (signal.isProtectiveLiquidation === true) {
    return globalConfig.liquidationOrderType;
  }
  return globalConfig.tradingOrderType;
}

/**
 * 计算未成交卖单的剩余数量（内部辅助）。
 * 默认行为：submittedQuantity 或 executedQuantity 无效时返回 0。
 *
 * @param order 未成交卖单快照
 * @returns 剩余数量（submittedQuantity - executedQuantity），无效时返回 0
 */
function resolveRemainingQuantity(order: PendingSellOrderSnapshot): number {
  const remaining = order.submittedQuantity - order.executedQuantity;
  return isValidPositiveNumber(remaining) ? remaining : 0;
}

/**
 * 根据未成交卖单与新股数量计算卖单合并决策（SUBMIT/REPLACE/CANCEL_AND_SUBMIT/SKIP）。
 * @param input 合并决策输入，包含标的、未成交卖单列表、新订单数量/价格/类型及是否保护性清仓
 * @returns 合并决策结果，包含动作类型、合并数量、目标订单 ID 及决策原因
 */
export function resolveSellMergeDecision(input: SellMergeDecisionInput): SellMergeDecision {
  const normalized = input.pendingOrders
    .map((order) => ({
      order,
      remaining: resolveRemainingQuantity(order),
    }))
    .filter((item) => item.remaining > 0);

  const pendingOrderIds = normalized.map((item) => item.order.orderId);
  const pendingRemainingQuantity = normalized.reduce((sum, item) => sum + item.remaining, 0);

  if (!Number.isFinite(input.newOrderQuantity) || input.newOrderQuantity <= 0) {
    return {
      action: 'SKIP',
      mergedQuantity: pendingRemainingQuantity,
      targetOrderId: null,
      price: null,
      pendingOrderIds,
      pendingRemainingQuantity,
      reason: 'no-additional-quantity',
    };
  }

  if (pendingRemainingQuantity <= 0) {
    return {
      action: 'SUBMIT',
      mergedQuantity: input.newOrderQuantity,
      targetOrderId: null,
      price: input.newOrderPrice,
      pendingOrderIds,
      pendingRemainingQuantity,
      reason: 'no-pending-sell',
    };
  }

  const mergedQuantity = pendingRemainingQuantity + input.newOrderQuantity;
  const hasMultiple = normalized.length > 1;
  const hasTypeMismatch = normalized.some((item) => item.order.orderType !== input.newOrderType);
  const hasNonReplaceableStatus = normalized.some((item) =>
    NON_REPLACEABLE_ORDER_STATUSES.has(item.order.status),
  );
  const hasNonReplaceableType = normalized.some((item) =>
    NON_REPLACEABLE_ORDER_TYPES.has(item.order.orderType),
  );

  if (
    input.isProtectiveLiquidation ||
    hasMultiple ||
    hasTypeMismatch ||
    hasNonReplaceableStatus ||
    hasNonReplaceableType
  ) {
    return {
      action: 'CANCEL_AND_SUBMIT',
      mergedQuantity,
      targetOrderId: null,
      price: input.newOrderPrice,
      pendingOrderIds,
      pendingRemainingQuantity,
      reason: 'cancel-and-merge',
    };
  }

  return {
    action: 'REPLACE',
    mergedQuantity,
    targetOrderId: normalized[0]?.order.orderId ?? null,
    price: input.newOrderPrice ?? normalized[0]?.order.submittedPrice ?? null,
    pendingOrderIds,
    pendingRemainingQuantity,
    reason: 'replace-and-merge',
  };
}

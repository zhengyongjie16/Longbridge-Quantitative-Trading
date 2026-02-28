import { isValidNumber } from '../../utils/indicatorHelpers/index.js';
import { DEFAULT_PERCENT_DECIMALS } from '../../constants/index.js';
import type { ObjectPool } from '../../utils/objectPool/types.js';
import type { UnrealizedLossMetrics, WarrantDistanceInfo } from '../../types/services.js';
import type { Quote } from '../../types/quote.js';

/**
 * 格式化行情数据显示为可读字段。默认行为：quote 为 null 时返回 null。
 *
 * @param quote 行情对象
 * @param symbol 标的代码
 * @returns 格式化后的行情显示对象，quote 无效时返回 null
 */
export function formatQuoteDisplay(
  quote: Quote | null,
  symbol: string,
): {
  readonly nameText: string;
  readonly codeText: string;
  readonly priceText: string;
  readonly changeAmountText: string;
  readonly changePercentText: string;
} | null {
  if (!quote) {
    return null;
  }

  const nameText = quote.name ?? '-';
  const currentPrice = quote.price;

  const priceText = Number.isFinite(currentPrice) ? currentPrice.toFixed(3) : String(currentPrice);

  let changeAmountText = '-';
  let changePercentText = '-';

  if (Number.isFinite(currentPrice) && Number.isFinite(quote.prevClose) && quote.prevClose !== 0) {
    const changeAmount = currentPrice - quote.prevClose;
    changeAmountText = `${changeAmount >= 0 ? '+' : ''}${changeAmount.toFixed(3)}`;

    const changePercent = (changeAmount / quote.prevClose) * 100;
    changePercentText = `${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}%`;
  }

  return {
    nameText,
    codeText: symbol,
    priceText,
    changeAmountText,
    changePercentText,
  };
}

/**
 * 检查数值是否发生变化（超过阈值）
 * @param current 当前值
 * @param last 上次值
 * @param threshold 变化阈值
 * @returns true表示值发生变化，false表示未变化
 */
export function hasChanged(
  current: number | null | undefined,
  last: number | null | undefined,
  threshold: number,
): boolean {
  if (!isValidNumber(current) || !isValidNumber(last)) {
    return false;
  }
  return Math.abs(current - last) > threshold;
}

/**
 * 检查单个指标值是否变化（当前有效且上次为空或超过阈值）
 * @param current 当前指标值
 * @param last 上次指标值，为 null/undefined 时视为首次出现
 * @param threshold 变化阈值
 * @returns 当前值有效且与上次相比超过阈值时返回 true
 */
export function indicatorChanged(
  current: number | null | undefined,
  last: number | null | undefined,
  threshold: number,
): boolean {
  return (
    Number.isFinite(current) &&
    (last === null || last === undefined || hasChanged(current, last, threshold))
  );
}

/**
 * 格式化距离回收价的显示文本
 * @param warrantDistanceInfo 牛熊证距离信息，为 null 时返回 null
 * @param decimals 小数位数，默认使用 DEFAULT_PERCENT_DECIMALS
 * @returns 格式化后的距离文本，距离无效时返回"距回收价=未知"，warrantDistanceInfo 为 null 时返回 null
 */
export function formatWarrantDistanceDisplay(
  warrantDistanceInfo: WarrantDistanceInfo | null,
  decimals: number = DEFAULT_PERCENT_DECIMALS,
): string | null {
  if (!warrantDistanceInfo) {
    return null;
  }

  const distance = warrantDistanceInfo.distanceToStrikePercent;
  if (distance === null || !Number.isFinite(distance)) {
    return '距回收价=未知';
  }

  const sign = distance >= 0 ? '+' : '';
  return `距回收价=${sign}${distance.toFixed(decimals)}%`;
}

/**
 * 格式化浮亏指标展示文本（持仓市值、持仓盈亏、订单数量）。
 * @param metrics 浮亏实时指标，null 时以 "-" 展示市值与持仓盈亏
 * @param orderCount 未平仓买入订单数量（笔数），null 时展示 "-"
 * @param decimals 金额小数位数，默认 2
 * @returns 统一格式文本
 */
export function formatPositionDisplay(
  metrics: UnrealizedLossMetrics | null,
  orderCount: number | null,
  decimals: number = 2,
): string {
  const marketValueText =
    metrics && Number.isFinite(metrics.r2) ? metrics.r2.toFixed(decimals) : '-';
  let pnlText: string;
  if (metrics && Number.isFinite(metrics.unrealizedPnL)) {
    const sign = metrics.unrealizedPnL >= 0 ? '+' : '';
    pnlText = `${sign}${metrics.unrealizedPnL.toFixed(decimals)}`;
  } else {
    pnlText = '-';
  }
  const orderCountText =
    orderCount !== null && Number.isFinite(orderCount) ? String(orderCount) : '-';

  return `持仓市值=${marketValueText} 持仓盈亏=${pnlText} 订单数量=${orderCountText}`;
}

/**
 * 从指标快照拷贝周期值到对象池记录
 * @param pool 对象池，用于复用 Record 对象避免频繁分配
 * @param snapshot 指标快照，为 null 时返回 null
 * @returns 从对象池获取并填充的周期值记录，snapshot 为 null 时返回 null
 */
export function copyPeriodRecord(
  pool: ObjectPool<Record<number, number>>,
  snapshot: Readonly<Record<number, number>> | null,
): Record<number, number> | null {
  if (!snapshot) {
    return null;
  }

  const record = pool.acquire();
  for (const key in snapshot) {
    const numKey = Number(key);
    const value = snapshot[numKey];
    if (value !== undefined) {
      record[numKey] = value;
    }
  }
  return record;
}

/**
 * 行情数据客户端模块的工具函数
 *
 * 功能：
 * - 从静态信息中提取交易单位（extractLotSize）
 * - 从静态信息中提取标的名称（extractName）
 * - K 线周期枚举转可读标签（formatPeriodForLog）
 */
import { Period } from 'longport';
import type { StaticInfo } from './types.js';

const PERIOD_LABEL_MAP: Readonly<Record<number, string>> = {
  [Period.Unknown]: '未知',
  [Period.Min_1]: '1分钟',
  [Period.Min_15]: '15分钟',
  [Period.Min_60]: '1小时',
} as const;

/**
 * 将 Period 枚举转为可读标签，用于日志等展示
 * @param period K 线周期枚举值
 * @returns 可读标签，如 "1分钟"、"日K"；未知值返回 "未知(n)"
 */
export function formatPeriodForLog(period: Period): string {
  const label = PERIOD_LABEL_MAP[period as number];
  return label ?? `未知(${period})`;
}

/**
 * 从静态信息中安全提取 lotSize
 * @param staticInfo 静态信息对象
 * @returns lotSize 值，如果无效则返回 undefined
 */
export const extractLotSize = (staticInfo: unknown): number | undefined => {
  if (!staticInfo || typeof staticInfo !== 'object') {
    return undefined;
  }

  const info = staticInfo as StaticInfo;
  const lotSizeValue = info.lotSize ?? info.lot_size ?? info.lot ?? null;

  if (lotSizeValue === null || lotSizeValue === undefined) {
    return undefined;
  }

  const parsed = Number(lotSizeValue);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  return undefined;
};

/**
 * 从静态信息中安全提取名称
 * @param staticInfo 静态信息对象
 * @returns 名称，优先返回香港名称，其次中文名称，最后英文名称
 */
export const extractName = (staticInfo: unknown): string | null => {
  if (!staticInfo || typeof staticInfo !== 'object') {
    return null;
  }

  const info = staticInfo as StaticInfo;
  return info.nameHk ?? info.nameCn ?? info.nameEn ?? null;
};

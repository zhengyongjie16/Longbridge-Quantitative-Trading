/**
 * 行情数据客户端模块的工具函数
 *
 * 功能：
 * - 从静态信息中提取交易单位（extractLotSize）
 * - 从静态信息中提取标的名称（extractName）
 * - K 线周期枚举转可读标签（formatPeriodForLog）
 */
import { NaiveDate, Period } from 'longport';
import { isValidPositiveNumber } from '../../utils/helpers/index.js';
import { getHKDateKey } from '../../utils/helpers/tradingTime.js';
import type { StaticInfo } from './types.js';

const PERIOD_LABEL_MAP: Readonly<Record<number, string>> = {
  [Period.Unknown]: '未知',
  [Period.Min_1]: '1分钟',
  [Period.Min_2]: '2分钟',
  [Period.Min_3]: '3分钟',
  [Period.Min_5]: '5分钟',
  [Period.Min_10]: '10分钟',
  [Period.Min_15]: '15分钟',
  [Period.Min_20]: '20分钟',
  [Period.Min_30]: '30分钟',
  [Period.Min_45]: '45分钟',
  [Period.Min_60]: '1小时',
  [Period.Min_120]: '2小时',
  [Period.Min_180]: '3小时',
  [Period.Min_240]: '4小时',
  [Period.Day]: '日K',
  [Period.Week]: '周K',
  [Period.Month]: '月K',
  [Period.Quarter]: '季K',
  [Period.Year]: '年K',
} as const;

/**
 * 将 Period 枚举转为可读标签，用于日志等展示
 * @param period K 线周期枚举值
 * @returns 可读标签，如 "1分钟"、"15分钟"；未知值返回 "未知(n)"
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
export function extractLotSize(staticInfo: unknown): number | undefined {
  if (!staticInfo || typeof staticInfo !== 'object') {
    return undefined;
  }

  // LongPort 静态信息 API 返回的对象结构与 StaticInfo 对应，这里作为信任边界桥接做结构性断言
  const info = staticInfo as StaticInfo;
  const lotSizeValue = info.lotSize ?? info.lot_size ?? info.lot ?? null;

  if (lotSizeValue === null || lotSizeValue === undefined) {
    return undefined;
  }

  const parsed = Number(lotSizeValue);
  if (isValidPositiveNumber(parsed)) {
    return parsed;
  }

  return undefined;
}

/**
 * 从静态信息中安全提取名称
 * @param staticInfo 静态信息对象
 * @returns 名称，优先返回香港名称，其次中文名称，最后英文名称
 */
export function extractName(staticInfo: unknown): string | null {
  if (!staticInfo || typeof staticInfo !== 'object') {
    return null;
  }

  // 同上：staticInfo 源自 LongPort 静态信息 API，结构与 StaticInfo 对应
  const info = staticInfo as StaticInfo;
  return info.nameHk ?? info.nameCn ?? info.nameEn ?? null;
}

/**
 * 获取港股日期键（UTC+8），确保返回非空值
 * @param date 时间对象
 * @returns YYYY-MM-DD 格式日期键
 */
export function resolveHKDateKey(date: Date): string {
  const hkDateKey = getHKDateKey(date);
  if (hkDateKey != null) {
    return hkDateKey;
  }

  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 将时间对象转换为港股日期的 NaiveDate
 * @param date 时间对象
 * @returns NaiveDate 实例
 */
export function resolveHKNaiveDate(date: Date): NaiveDate {
  const dateKey = resolveHKDateKey(date);
  const parts = dateKey.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  return new NaiveDate(year, month, day);
}

import { DOOMSDAY, TIME } from '../../constants/index.js';
import type { Quote } from '../../types/quote.js';
import type { MarketDataClient } from '../../types/services.js';

/**
 * 批量获取行情数据。默认行为：symbols 为空时返回空 Map，否则调用 marketDataClient.getQuotes。
 *
 * @param marketDataClient 行情客户端
 * @param symbols 标的代码可迭代对象
 * @returns 标的代码到行情数据的 Map（无行情时为 null）
 */
export async function batchGetQuotes(
  marketDataClient: MarketDataClient,
  symbols: Iterable<string>,
): Promise<Map<string, Quote | null>> {
  const symbolArray = [...symbols];

  if (symbolArray.length === 0) {
    return new Map();
  }

  return marketDataClient.getQuotes(symbolArray);
}

/**
 * 判断是否处于末日保护的买入截止窗口。默认行为：date 无效返回 false；半日市按 12:00 收盘计算。
 *
 * @param date 时间对象（UTC）
 * @param isHalfDay 是否为半日交易日，默认 false
 * @returns 处于买入截止窗口时返回 true，否则返回 false
 */
export function isWithinDoomsdayBuyCutoffWindow(
  date: Date | null | undefined,
  isHalfDay: boolean = false,
): boolean {
  return isBeforeCloseMinutes(date, DOOMSDAY.BUY_CUTOFF_MINUTES_BEFORE_CLOSE, isHalfDay);
}

/**
 * 判断是否处于末日保护的清仓接管窗口。默认行为：date 无效返回 false；半日市按 12:00 收盘计算。
 *
 * @param date 时间对象（UTC）
 * @param isHalfDay 是否为半日交易日，默认 false
 * @returns 处于清仓接管窗口时返回 true，否则返回 false
 */
export function isWithinDoomsdayClearanceTakeoverWindow(
  date: Date | null | undefined,
  isHalfDay: boolean = false,
): boolean {
  return isBeforeCloseMinutes(date, DOOMSDAY.CLEARANCE_TAKEOVER_MINUTES_BEFORE_CLOSE, isHalfDay);
}

/**
 * 获取买入截止窗口的人类可读时间范围字符串。默认行为：半日市按 12:00 收盘计算，正常日按 16:00 收盘计算。
 *
 * @param isHalfDay 是否为半日交易日
 * @returns 如 `15:45-16:00` / `11:45-12:00`
 */
export function getDoomsdayBuyCutoffWindowRangeLabel(isHalfDay: boolean): string {
  return formatBeforeCloseWindowRange(DOOMSDAY.BUY_CUTOFF_MINUTES_BEFORE_CLOSE, isHalfDay);
}

/**
 * 获取清仓接管窗口的人类可读时间范围字符串。默认行为：半日市按 12:00 收盘计算，正常日按 16:00 收盘计算。
 *
 * @param isHalfDay 是否为半日交易日
 * @returns 如 `15:55-16:00` / `11:55-12:00`
 */
export function getDoomsdayClearanceTakeoverWindowRangeLabel(isHalfDay: boolean): string {
  return formatBeforeCloseWindowRange(DOOMSDAY.CLEARANCE_TAKEOVER_MINUTES_BEFORE_CLOSE, isHalfDay);
}

/**
 * 判断是否在当日收盘前指定分钟数内（用于末日保护等）。半日市按 12:00 收盘，正常日按 16:00。
 *
 * @param date 时间对象（UTC）
 * @param minutes 距离收盘的分钟数（正数）
 * @param isHalfDay 是否为半日交易日，默认 false
 * @returns 在收盘前该分钟数窗口内返回 true，否则返回 false
 */
function isBeforeCloseMinutes(
  date: Date | null | undefined,
  minutes: number,
  isHalfDay: boolean = false,
): boolean {
  if (!date || !Number.isFinite(minutes) || minutes <= 0) {
    return false;
  }

  const hkTime = resolveHKTime(date);
  if (!hkTime) {
    return false;
  }

  const closeHour = isHalfDay ? 12 : 16;
  const closeMinutes = closeHour * 60;
  const currentMinutes = hkTime.hkHour * 60 + hkTime.hkMinute;

  return currentMinutes >= closeMinutes - minutes && currentMinutes < closeMinutes;
}

/**
 * 将“距收盘前 N 分钟”的窗口格式化为人类可读时间范围。默认行为：minutes 非正数时返回收盘时刻范围。
 *
 * @param minutes 距离收盘的分钟数（正数）
 * @param isHalfDay 是否为半日交易日
 * @returns 如 `15:45-16:00`
 */
function formatBeforeCloseWindowRange(minutes: number, isHalfDay: boolean): string {
  const closeHour = isHalfDay ? 12 : 16;
  const closeTotalMinutes = closeHour * 60;
  const safeMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
  const startTotalMinutes = closeTotalMinutes - safeMinutes;
  return `${formatHourMinute(startTotalMinutes)}-${formatHourMinute(closeTotalMinutes)}`;
}

/**
 * 将分钟数格式化为 `HH:mm` 字符串。
 *
 * @param totalMinutes 自午夜以来的分钟数
 * @returns 固定两位小时与分钟的时间字符串
 */
function formatHourMinute(totalMinutes: number): string {
  const normalizedTotalMinutes = Math.max(0, Math.trunc(totalMinutes));
  const hour = Math.floor(normalizedTotalMinutes / 60);
  const minute = normalizedTotalMinutes % 60;
  return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
}

/**
 * 将 UTC 时间转换为香港时区（UTC+8）的小时与分钟。默认行为：date 为 null/undefined 时返回 null。
 *
 * @param date 时间对象（UTC）
 * @returns 香港时区的小时与分钟（hkHour、hkMinute），无效时返回 null
 */
function resolveHKTime(date: Date | null | undefined): { hkHour: number; hkMinute: number } | null {
  if (!date) {
    return null;
  }

  const utcHour = date.getUTCHours();
  const utcMinute = date.getUTCMinutes();
  const offsetHours = TIME.HONG_KONG_TIMEZONE_OFFSET_MS / (60 * 60 * 1000);
  return {
    hkHour: (utcHour + offsetHours) % 24,
    hkMinute: utcMinute,
  };
}

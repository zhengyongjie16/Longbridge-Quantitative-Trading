import { TIME } from '../../constants/index.js';
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
 * 判断是否在当日收盘前 15 分钟内（末日保护：拒绝买入）。默认行为：date 无效返回 false；半日市按 12:00 收盘计算。
 *
 * @param date 时间对象（UTC）
 * @param isHalfDay 是否为半日交易日，默认 false
 * @returns 在收盘前 15 分钟窗口内为 true，否则为 false
 */
export function isBeforeClose15Minutes(
  date: Date | null | undefined,
  isHalfDay: boolean = false,
): boolean {
  return isBeforeCloseMinutes(date, 15, isHalfDay);
}

/**
 * 判断是否在当日收盘前 5 分钟内（末日保护：自动清仓）。默认行为：date 无效返回 false；半日市按 12:00 收盘计算。
 *
 * @param date 时间对象（UTC）
 * @param isHalfDay 是否为半日交易日，默认 false
 * @returns 在收盘前 5 分钟窗口内为 true，否则为 false
 */
export function isBeforeClose5Minutes(
  date: Date | null | undefined,
  isHalfDay: boolean = false,
): boolean {
  return isBeforeCloseMinutes(date, 5, isHalfDay);
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

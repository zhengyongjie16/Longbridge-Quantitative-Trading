/**
 * 末日保护模块独享的工具函数
 */

import type { MarketDataClient, Quote } from '../../types/index.js';
import type { HKTime } from '../../utils/helpers/types.js';

/**
 * 将UTC时间转换为香港时区（UTC+8）
 * @param date 时间对象（UTC时间）
 * @returns 香港时区的小时和分钟，如果date无效则返回null
 */
function getHKTime(date: Date | null | undefined): HKTime | null {
  if (!date) return null;
  const utcHour = date.getUTCHours();
  const utcMinute = date.getUTCMinutes();
  return {
    hkHour: (utcHour + 8) % 24,
    hkMinute: utcMinute,
  };
}

/**
 * 判断是否在当日收盘前15分钟内（末日保护程序：拒绝买入）
 * 港股正常交易日收盘时间：下午 16:00，收盘前15分钟：15:45 - 15:59
 * 港股半日交易日收盘时间：中午 12:00，收盘前15分钟：11:45 - 11:59
 * @param date 时间对象（应该是UTC时间）
 * @param isHalfDay 是否是半日交易日
 * @returns true表示在收盘前15分钟，false表示不在
 */
export function isBeforeClose15Minutes(date: Date | null | undefined, isHalfDay: boolean = false): boolean {
  if (!date) return false;
  const hkTime = getHKTime(date);
  if (!hkTime) return false;
  const { hkHour, hkMinute } = hkTime;

  if (isHalfDay) {
    // 半日交易：收盘前15分钟为 11:45 - 11:59:59（12:00收盘）
    return hkHour === 11 && hkMinute >= 45;
  } else {
    // 正常交易日：收盘前15分钟为 15:45 - 15:59:59（16:00收盘）
    return hkHour === 15 && hkMinute >= 45;
  }
}

/**
 * 判断是否在当日收盘前5分钟内（末日保护程序：自动清仓）
 * 港股正常交易日收盘时间：下午 16:00，收盘前5分钟：15:55 - 15:59
 * 港股半日交易日收盘时间：中午 12:00，收盘前5分钟：11:55 - 11:59
 * @param date 时间对象（应该是UTC时间）
 * @param isHalfDay 是否是半日交易日
 * @returns true表示在收盘前5分钟，false表示不在
 */
export function isBeforeClose5Minutes(date: Date | null | undefined, isHalfDay: boolean = false): boolean {
  if (!date) return false;
  const hkTime = getHKTime(date);
  if (!hkTime) return false;
  const { hkHour, hkMinute } = hkTime;

  if (isHalfDay) {
    // 半日交易：收盘前5分钟为 11:55 - 11:59:59（12:00收盘）
    return hkHour === 11 && hkMinute >= 55;
  } else {
    // 正常交易日：收盘前5分钟为 15:55 - 15:59:59（16:00收盘）
    return hkHour === 15 && hkMinute >= 55;
  }
}

/**
 * 批量获取行情数据
 * 使用 marketDataClient.getQuotes 进行单次 API 调用批量获取，减少 API 调用次数
 *
 * @param marketDataClient 行情客户端
 * @param symbols 标的代码列表
 * @returns 标的代码到行情数据的映射（使用规范化后的标的代码作为 key）
 */
export async function batchGetQuotes(
  marketDataClient: MarketDataClient,
  symbols: Iterable<string>,
): Promise<Map<string, Quote | null>> {
  const symbolArray = Array.from(symbols);

  if (symbolArray.length === 0) {
    return new Map();
  }

  // 使用单次 API 调用批量获取所有行情
  return marketDataClient.getQuotes(symbolArray);
}

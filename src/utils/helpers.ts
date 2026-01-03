/**
 * 工具函数模块
 *
 * 功能：
 * - 港股代码规范化（添加 .HK 后缀）
 * - Decimal 类型转换
 * - 时间格式化（北京时区）
 * - 数值格式化
 *
 * 核心函数：
 * - normalizeHKSymbol()：规范化港股代码
 * - decimalToNumber()：转换 LongPort API 的 Decimal 对象
 * - toBeijingTimeIso() / toBeijingTimeLog()：UTC 到北京时间转换
 * - formatSymbolDisplay() / formatQuoteDisplay()：格式化显示
 */

import type { PoolableSignal, Quote, Signal, SignalType } from '../types/index.js';

/**
 * LongPort Decimal 类型接口
 */
interface DecimalLike {
  toNumber(): number;
}

/**
 * 检查值是否已定义（不是 null 或 undefined）
 * @param value 待检查的值
 * @returns 如果值不是 null 或 undefined 返回 true，否则返回 false
 */
export function isDefined<T>(value: T | null | undefined): value is T {
  return value != null; // != null 会同时检查 null 和 undefined
}

/**
 * 规范化港股代码，自动添加 .HK 后缀（如果还没有）
 * @param symbol 标的代码，例如 "68547" 或 "68547.HK"
 * @returns 规范化后的代码，例如 "68547.HK"
 */
export function normalizeHKSymbol(symbol: string | null | undefined): string {
  if (!symbol || typeof symbol !== 'string') {
    return '';
  }
  // 如果已经包含 .HK、.US 等后缀，直接返回
  if (symbol.includes('.')) {
    return symbol;
  }
  // 否则添加 .HK 后缀
  return `${symbol}.HK`;
}

/**
 * 将 Decimal 类型转换为数字
 * @param decimalLike Decimal 对象或数字
 * @returns 转换后的数字，如果输入为 null/undefined 返回 NaN（便于后续 Number.isFinite() 检查）
 */
export function decimalToNumber(decimalLike: DecimalLike | number | string | null | undefined): number {
  // 如果输入为 null 或 undefined，返回 NaN 而非 0
  // 这样 Number.isFinite() 检查会返回 false，避免错误地使用 0 作为有效值
  if (decimalLike === null || decimalLike === undefined) {
    return NaN;
  }
  if (typeof decimalLike === 'object' && 'toNumber' in decimalLike) {
    return decimalLike.toNumber();
  }
  return Number(decimalLike);
}

/**
 * 格式化数字，保留指定小数位数
 * @param num 要格式化的数字
 * @param digits 保留的小数位数，默认为 2
 * @returns 格式化后的字符串，如果数字无效则返回 "-"
 */
export function formatNumber(num: number | null | undefined, digits: number = 2): string {
  if (num === null || num === undefined) {
    return '-';
  }
  return Number.isFinite(num) ? num.toFixed(digits) : String(num ?? '-');
}

/**
 * 账户渠道映射表
 */
const channelMap: Record<string, string> = {
  lb_papertrading: '模拟交易',
  paper_trading: '模拟交易',
  papertrading: '模拟交易',
  real_trading: '实盘交易',
  realtrading: '实盘交易',
  live: '实盘交易',
  demo: '模拟交易',
};

/**
 * 格式化账户渠道显示名称
 * @param accountChannel 账户渠道代码
 * @returns 格式化的账户渠道名称
 */
export function formatAccountChannel(accountChannel: string | null | undefined): string {
  if (!accountChannel || typeof accountChannel !== 'string') {
    return '未知账户';
  }

  // 转换为小写进行匹配
  const lowerChannel = accountChannel.toLowerCase();

  // 如果找到映射，返回中文名称
  if (channelMap[lowerChannel]) {
    return channelMap[lowerChannel];
  }

  // 否则返回原始值
  return accountChannel;
}

/**
 * 格式化标的显示：中文名称(代码.HK)
 * @param symbol 标的代码
 * @param symbolName 标的中文名称（可选）
 * @returns 格式化后的标的显示
 */
export function formatSymbolDisplay(symbol: string | null | undefined, symbolName: string | null = null): string {
  if (!symbol) {
    return '';
  }
  const normalizedSymbol = normalizeHKSymbol(symbol);
  if (symbolName) {
    return `${symbolName}(${normalizedSymbol})`;
  }
  return normalizedSymbol;
}

/**
 * 根据信号标的获取对应的中文名称
 * @param signalSymbol 信号中的标的代码
 * @param longSymbol 做多标的代码
 * @param shortSymbol 做空标的代码
 * @param longSymbolName 做多标的中文名称
 * @param shortSymbolName 做空标的中文名称
 * @returns 标的中文名称，如果未找到则返回原始代码
 */
export function getSymbolName(
  signalSymbol: string,
  longSymbol: string | null,
  shortSymbol: string | null,
  longSymbolName: string | null,
  shortSymbolName: string | null,
): string | null {
  const normalizedSigSymbol = normalizeHKSymbol(signalSymbol);
  const normalizedLongSymbol = longSymbol ? normalizeHKSymbol(longSymbol) : null;
  const normalizedShortSymbol = shortSymbol ? normalizeHKSymbol(shortSymbol) : null;

  if (normalizedSigSymbol === normalizedLongSymbol) {
    return longSymbolName;
  } else if (normalizedSigSymbol === normalizedShortSymbol) {
    return shortSymbolName;
  }
  return signalSymbol;
}

/**
 * 时间格式化选项
 */
interface TimeFormatOptions {
  format?: 'iso' | 'log';
}

/**
 * 将时间转换为北京时间（UTC+8）的字符串
 * @param date 时间对象，如果为 null 则使用当前时间
 * @param options 格式选项
 * @returns 北京时间的字符串格式
 */
function toBeijingTime(date: Date | null = null, options: TimeFormatOptions = {}): string {
  const { format = 'iso' } = options;
  const targetDate = date || new Date();
  // 转换为北京时间（UTC+8）
  const beijingOffset = 8 * 60 * 60 * 1000; // 8小时的毫秒数
  const beijingTime = new Date(targetDate.getTime() + beijingOffset);

  // 使用UTC方法获取年月日时分秒，这样得到的就是北京时间
  const year = beijingTime.getUTCFullYear();
  const month = String(beijingTime.getUTCMonth() + 1).padStart(2, '0');
  const day = String(beijingTime.getUTCDate()).padStart(2, '0');
  const hours = String(beijingTime.getUTCHours()).padStart(2, '0');
  const minutes = String(beijingTime.getUTCMinutes()).padStart(2, '0');
  const seconds = String(beijingTime.getUTCSeconds()).padStart(2, '0');

  return format === 'log'
    ? // 日志格式：YYYY-MM-DD HH:mm:ss.sss（包含毫秒）
    `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${String(
      beijingTime.getUTCMilliseconds(),
    ).padStart(3, '0')}`
    : // ISO 格式：YYYY/MM/DD/HH:mm:ss（不包含毫秒）
    `${year}/${month}/${day}/${hours}:${minutes}:${seconds}`;
}

/**
 * 将时间转换为北京时间（UTC+8）的 ISO 格式字符串
 * 格式：YYYY/MM/DD/HH:mm:ss
 * @param date 时间对象，如果为 null 则使用当前时间
 * @returns 北京时间的字符串格式 YYYY/MM/DD/HH:mm:ss
 */
export function toBeijingTimeIso(date: Date | null = null): string {
  return toBeijingTime(date, { format: 'iso' });
}

/**
 * 将时间转换为北京时间（UTC+8）的日志格式字符串
 * 格式：YYYY-MM-DD HH:mm:ss.sss（包含毫秒）
 * @param date 时间对象，如果为 null 则使用当前时间
 * @returns 北京时间的字符串格式 YYYY-MM-DD HH:mm:ss.sss
 */
export function toBeijingTimeLog(date: Date | null = null): string {
  return toBeijingTime(date, { format: 'log' });
}

/**
 * 行情显示格式化结果
 */
export interface QuoteDisplayResult {
  nameText: string;
  codeText: string;
  priceText: string;
  changeAmountText: string;
  changePercentText: string;
}

/**
 * 格式化行情数据显示
 * @param quote 行情对象
 * @param symbol 标的代码
 * @returns 格式化后的行情显示对象，如果quote无效则返回null
 */
export function formatQuoteDisplay(quote: Quote | null, symbol: string): QuoteDisplayResult | null {
  if (!quote) {
    return null;
  }

  const nameText = quote.name ?? '-';
  const codeText = normalizeHKSymbol(symbol);
  const currentPrice = quote.price;

  // 最新价格
  const priceText = Number.isFinite(currentPrice)
    ? currentPrice.toFixed(3)
    : String(currentPrice ?? '-');

  // 涨跌额和涨跌幅度
  let changeAmountText = '-';
  let changePercentText = '-';

  if (
    Number.isFinite(currentPrice) &&
    Number.isFinite(quote.prevClose) &&
    quote.prevClose !== 0
  ) {
    // 涨跌额 = 当前价格 - 前收盘价
    const changeAmount = currentPrice - quote.prevClose;
    changeAmountText = `${changeAmount >= 0 ? '+' : ''}${changeAmount.toFixed(3)}`;

    // 涨跌幅度 = (当前价格 - 前收盘价) / 前收盘价 * 100%
    const changePercent = (changeAmount / quote.prevClose) * 100;
    changePercentText = `${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}%`;
  }

  return {
    nameText,
    codeText,
    priceText,
    changeAmountText,
    changePercentText,
  };
}

/**
 * 类型守卫：判断是否为有效的 SignalType
 */
export const isSignalType = (value: unknown): value is SignalType => {
  return (
    value === 'BUYCALL' ||
    value === 'SELLCALL' ||
    value === 'BUYPUT' ||
    value === 'SELLPUT' ||
    value === 'HOLD'
  );
};

/**
* 辅助函数：判断是否为买入操作
*/
export const isBuyAction = (action: SignalType): boolean => {
  return action === 'BUYCALL' || action === 'BUYPUT';
};

/**
* 辅助函数：判断是否为卖出操作
*/
export const isSellAction = (action: SignalType): boolean => {
  return action === 'SELLCALL' || action === 'SELLPUT';
};

/**
* 类型守卫：验证对象池对象是否为有效 Signal
*/
export const isValidSignal = (obj: PoolableSignal): obj is Signal => {
  return (
    obj.symbol !== null &&
    obj.action !== null &&
    isSignalType(obj.action)
  );
};

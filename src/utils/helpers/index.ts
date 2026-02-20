import type { MonitorState } from '../../types/state.js';
import type { IndicatorSnapshot, Quote } from '../../types/quote.js';
import type { MonitorConfig } from '../../types/config.js';
import type { SignalType } from '../../types/signal.js';
import { inspect } from 'node:util';
import { Decimal } from 'longport';
import { TIME, SYMBOL_WITH_REGION_REGEX, ACCOUNT_CHANNEL_MAP } from '../../constants/index.js';
import type { DecimalLike, QuoteDisplayResult, TimeFormatOptions } from './types.js';
import { logger } from '../logger/index.js';
import { kdjObjectPool, macdObjectPool, periodRecordPool } from '../objectPool/index.js';

/**
 * 检查值是否已定义（不是 null 或 undefined）。默认行为：无。
 *
 * @param value 待检查的值
 * @returns 值非 null 且非 undefined 时返回 true，否则返回 false
 */
export function isDefined<T>(value: T | null | undefined): value is T {
  return value != null; // != null 会同时检查 null 和 undefined
}

/**
 * 类型保护：检查是否为 Error 实例（内部使用）
 * @param value 待检查的值
 * @returns 如果是 Error 实例返回 true，同时收窄类型为 Error
 */
function isError(value: unknown): value is Error {
  return value instanceof Error;
}

/**
 * 类型保护：检查是否为类似错误的对象（内部使用）
 * @param value 待检查的值
 * @returns 如果对象包含常见错误属性（message/error/msg）返回 true，同时收窄类型为 Record<string, unknown>
 */
function isErrorLike(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  // 类型收窄：已确认 value 是 object 且非 null，使用类型断言转换为 Record
  const obj = value as Record<string, unknown>;
  return typeof obj['message'] === 'string' ||
         typeof obj['error'] === 'string' ||
         typeof obj['msg'] === 'string' ||
         typeof obj['code'] === 'string';
}

/**
 * 校验标的代码格式（ticker.region）。默认行为：null/undefined 或非字符串返回 false。
 *
 * @param symbol 标的代码，例如 "68547.HK"
 * @returns 符合 ticker.region 格式时返回 true，否则返回 false
 */
export function isSymbolWithRegion(symbol: string | null | undefined): symbol is string {
  if (!symbol || typeof symbol !== 'string') {
    return false;
  }
  return SYMBOL_WITH_REGION_REGEX.test(symbol);
}

/**
 * 将值转换为 LongPort Decimal 类型。默认行为：非 number/string/Decimal 时返回 Decimal.ZERO()。
 *
 * @param value 要转换的值（number、string 或已存在的 Decimal）
 * @returns Decimal 对象，无效输入时返回 Decimal.ZERO()
 */
export function toDecimal(value: unknown): Decimal {
  if (value instanceof Decimal) {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'string') {
    return new Decimal(value);
  }
  return Decimal.ZERO();
}

/**
 * 将 Decimal 类型转换为数字。默认行为：null/undefined 返回 NaN，便于调用方用 Number.isFinite() 判断。
 *
 * @param decimalLike Decimal 对象、数字、字符串或 null/undefined
 * @returns 转换后的数字，null/undefined 时返回 NaN
 */
export function decimalToNumber(decimalLike: DecimalLike | number | string | null | undefined): number {
  // 如果输入为 null 或 undefined，返回 NaN 而非 0
  // 这样 Number.isFinite() 检查会返回 false，避免错误地使用 0 作为有效值
  if (decimalLike == null) {
    return Number.NaN;
  }
  if (typeof decimalLike === 'object' && 'toNumber' in decimalLike) {
    return decimalLike.toNumber();
  }
  return Number(decimalLike);
}

/**
 * 检查值是否为有效的正数（有限且大于 0）。默认行为：非 number 或非正数返回 false。
 *
 * @param value 待检查的值
 * @returns 为有限正数时返回 true，否则返回 false
 */
export function isValidPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * 格式化数字，保留指定小数位数。默认行为：num 为 null/undefined 或非有限数时返回 "-"；digits 默认为 2。
 *
 * @param num 要格式化的数字
 * @param digits 保留的小数位数，默认 2
 * @returns 格式化后的字符串，无效时返回 "-"
 */
export function formatNumber(num: number | null | undefined, digits: number = 2): string {
  if (num === null || num === undefined) {
    return '-';
  }
  return Number.isFinite(num) ? num.toFixed(digits) : String(num);
}

/**
 * 格式化账户渠道显示名称。默认行为：accountChannel 为空或非字符串时返回「未知账户」。
 *
 * @param accountChannel 账户渠道代码
 * @returns 映射后的显示名称，无效时返回「未知账户」
 */
export function formatAccountChannel(accountChannel: string | null | undefined): string {
  if (!accountChannel || typeof accountChannel !== 'string') return '未知账户';
  const key = accountChannel.toLowerCase();
  return ACCOUNT_CHANNEL_MAP[key] ?? accountChannel;
}

/**
 * 格式化标的显示为「中文名称(代码)」。默认行为：symbol 为空返回空串；symbolName 为空时仅返回代码。
 *
 * @param symbol 标的代码
 * @param symbolName 标的中文名称，默认 null
 * @returns 格式化后的显示字符串
 */
export function formatSymbolDisplay(symbol: string | null | undefined, symbolName: string | null = null): string {
  if (!symbol) {
    return '';
  }
  if (symbolName) {
    return `${symbolName}(${symbol})`;
  }
  return symbol;
}

/**
 * 将时间转换为香港时区（UTC+8）字符串，支持 iso / log 两种格式（内部使用）。
 * @param date - 时间对象，默认当前时间
 * @param options - 格式选项，format 为 'log' 时含毫秒
 * @returns 香港时间字符串
 */
function toHongKongTime(date: Date | null = null, options: TimeFormatOptions = {}): string {
  const { format = 'iso' } = options;
  const targetDate = date || new Date();
  // 转换为香港时间（UTC+8）
  const hkOffset = TIME.HONG_KONG_TIMEZONE_OFFSET_MS;
  const hkTime = new Date(targetDate.getTime() + hkOffset);

  // 使用UTC方法获取年月日时分秒，这样得到的就是香港时间
  const year = hkTime.getUTCFullYear();
  const month = String(hkTime.getUTCMonth() + 1).padStart(2, '0');
  const day = String(hkTime.getUTCDate()).padStart(2, '0');
  const hours = String(hkTime.getUTCHours()).padStart(2, '0');
  const minutes = String(hkTime.getUTCMinutes()).padStart(2, '0');
  const seconds = String(hkTime.getUTCSeconds()).padStart(2, '0');

  if (format === 'log') {
    // 日志格式：YYYY-MM-DD HH:mm:ss.sss（包含毫秒）
    const milliseconds = String(hkTime.getUTCMilliseconds()).padStart(3, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${milliseconds}`;
  }

  // ISO 格式：YYYY/MM/DD/HH:mm:ss（不包含毫秒）
  return `${year}/${month}/${day}/${hours}:${minutes}:${seconds}`;
}

/**
 * 将时间转换为香港时间（UTC+8）的 ISO 格式字符串。默认行为：date 为 null 时使用当前时间；格式 YYYY/MM/DD/HH:mm:ss。
 *
 * @param date 时间对象，默认 null（当前时间）
 * @returns 香港时间字符串 YYYY/MM/DD/HH:mm:ss
 */
export function toHongKongTimeIso(date: Date | null = null): string {
  return toHongKongTime(date, { format: 'iso' });
}

/**
 * 将时间转换为香港时间（UTC+8）的日志格式字符串。默认行为：date 为 null 时使用当前时间；格式含毫秒 YYYY-MM-DD HH:mm:ss.sss。
 *
 * @param date 时间对象，默认 null（当前时间）
 * @returns 香港时间字符串 YYYY-MM-DD HH:mm:ss.sss
 */
export function toHongKongTimeLog(date: Date | null = null): string {
  return toHongKongTime(date, { format: 'log' });
}

/**
 * 格式化行情数据显示为可读字段。默认行为：quote 为 null 时返回 null。
 *
 * @param quote 行情对象
 * @param symbol 标的代码
 * @returns 格式化后的行情显示对象，quote 无效时返回 null
 */
export function formatQuoteDisplay(quote: Quote | null, symbol: string): QuoteDisplayResult | null {
  if (!quote) {
    return null;
  }

  const nameText = quote.name ?? '-';
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
    codeText: symbol,
    priceText,
    changeAmountText,
    changePercentText,
  };
}

/**
 * 从行情对象生成标的显示字符串。默认行为：quote 存在时返回「中文名称(代码)」，否则返回 symbol。
 *
 * @param quote 行情对象（可选）
 * @param symbol 标的代码
 * @returns 格式化后的标的显示字符串
 */
export function formatSymbolDisplayFromQuote(quote: Quote | null | undefined, symbol: string): string {
  if (quote) {
    const display = formatQuoteDisplay(quote, symbol);
    return display ? `${display.nameText}(${display.codeText})` : symbol;
  }
  return symbol;
}

/**
 * 判断是否为买入操作。默认行为：无。
 *
 * @param action 信号类型
 * @returns 为 BUYCALL 或 BUYPUT 时返回 true
 */
export function isBuyAction(action: SignalType): boolean {
  return action === 'BUYCALL' || action === 'BUYPUT';
}

/**
 * 判断是否为卖出操作。默认行为：无。
 *
 * @param action 信号类型
 * @returns 为 SELLCALL 或 SELLPUT 时返回 true
 */
export function isSellAction(action: SignalType): boolean {
  return action === 'SELLCALL' || action === 'SELLPUT';
}

/**
 * 获取做多标的方向名称。默认行为：无参数，固定返回「做多标的」。
 *
 * @returns 做多标的方向名称字符串
 */
export function getLongDirectionName(): string {
  return '做多标的';
}

/**
 * 获取做空标的方向名称。默认行为：无参数，固定返回「做空标的」。
 *
 * @returns 做空标的方向名称字符串
 */
export function getShortDirectionName(): string {
  return '做空标的';
}

/** 信号操作描述映射 */
const SIGNAL_ACTION_DESCRIPTIONS: Record<SignalType, string> = {
  'BUYCALL': '买入做多标的（做多）',
  'SELLCALL': '卖出做多标的（平仓）',
  'BUYPUT': '买入做空标的（做空）',
  'SELLPUT': '卖出做空标的（平仓）',
  'HOLD': '持有',
};

/**
 * 将信号类型格式化为可读操作描述，用于日志与展示。
 *
 * @param action 信号类型（BUYCALL/SELLCALL/BUYPUT/SELLPUT/HOLD）
 * @returns 对应的中文描述字符串
 */
function getSignalActionDescription(action: SignalType): string {
  return SIGNAL_ACTION_DESCRIPTIONS[action] || `未知操作(${action})`;
}

/**
 * 格式化信号日志（标的显示为「中文名称(代码）」）。默认行为：reason 为空时使用「策略信号」。
 *
 * @param signal 包含 action、symbol、symbolName、reason 的对象
 * @returns 格式化后的信号日志字符串
 */
export function formatSignalLog(signal: { action: SignalType; symbol: string; symbolName?: string | null; reason?: string | null }): string {
  const actionDesc = getSignalActionDescription(signal.action);
  const symbolDisplay = formatSymbolDisplay(signal.symbol, signal.symbolName ?? null);
  return `${actionDesc} ${symbolDisplay} - ${signal.reason || '策略信号'}`;
}

/**
 * 将错误对象格式化为可读字符串。默认行为：null/undefined 返回「未知错误」；Error 取 message；类错误对象取 message/error/msg/code；否则 JSON 或 inspect。
 *
 * @param err 任意错误或未知值
 * @returns 可读错误消息字符串
 */
export function formatError(err: unknown): string {
  // null/undefined
  if (err == null) {
    return '未知错误';
  }
  // 字符串直接返回
  if (typeof err === 'string') {
    return err;
  }
  // Error 实例优先提取 message（使用类型保护）
  if (isError(err)) {
    return err.message || err.name || 'Error';
  }
  // 基本类型直接转换
  if (typeof err !== 'object') {
    return inspect(err, { depth: 5, maxArrayLength: 100 });
  }
  // 处理类似错误的对象（使用类型保护）
  if (isErrorLike(err)) {
    const errorKeys = ['message', 'error', 'msg', 'code'] as const;
    for (const key of errorKeys) {
      const value = err[key];
      if (typeof value === 'string' && value) {
        return value;
      }
    }
  }
  // 尝试 JSON 序列化
  try {
    const jsonStr = JSON.stringify(err);
    return jsonStr;
  } catch {
    // 如果 JSON 序列化失败，使用 inspect 来显示对象内容
    // 限制深度和数组长度，避免输出过长
    return inspect(err, { depth: 5, maxArrayLength: 100 });
  }
}

/**
 * 异步延迟指定毫秒数，无效值时使用 1000ms
 * @param ms 延迟毫秒数
 * @returns Promise，延迟结束后 resolve
 */
export async function sleep(ms: number): Promise<void> {
  const delay = Number(ms);
  if (!Number.isFinite(delay) || delay < 0) {
    logger.warn(`[sleep] 无效的延迟时间 ${ms}，使用默认值 ${TIME.MILLISECONDS_PER_SECOND}ms`);
    return new Promise((resolve) => setTimeout(resolve, TIME.MILLISECONDS_PER_SECOND));
  }
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * 根据监控配置初始化单标的监控状态。默认行为：无；所有可更新字段初始为 null 或空。
 *
 * @param config 监控配置（monitorSymbol 等）
 * @returns 初始化的 MonitorState
 */
export function initMonitorState(config: MonitorConfig): MonitorState {
  return {
    monitorSymbol: config.monitorSymbol,
    monitorPrice: null,
    longPrice: null,
    shortPrice: null,
    signal: null,
    pendingDelayedSignals: [],
    monitorValues: null,
    lastMonitorSnapshot: null,
    lastCandleFingerprint: null,
  };
}

/**
 * 释放快照中的池化对象（如果它们没有被 monitorValues 引用），避免重复归还同一引用导致池状态异常。
 * @param snapshot 要释放的快照
 * @param monitorValues 监控值对象，用于检查引用
 * @returns 无返回值
 */
export function releaseSnapshotObjects(
  snapshot: IndicatorSnapshot | null,
  monitorValues: MonitorState['monitorValues'],
): void {
  if (!snapshot) {
    return;
  }

  const releasePeriodRecord = (
    snapshotRecord: Readonly<Record<number, number>> | null,
    monitorRecord: Readonly<Record<number, number>> | null | undefined,
  ): void => {
    if (!snapshotRecord || monitorRecord === snapshotRecord) {
      return;
    }
    // snapshot 中的周期记录来自 periodRecordPool，可安全回收到池中复用
    periodRecordPool.release(snapshotRecord as Record<number, number>);
  };

  // 释放周期指标对象（如果它们没有被 monitorValues 引用）
  releasePeriodRecord(snapshot.ema, monitorValues?.ema);
  releasePeriodRecord(snapshot.rsi, monitorValues?.rsi);
  releasePeriodRecord(snapshot.psy, monitorValues?.psy);

  // 释放 KDJ 对象（如果它没有被 monitorValues 引用）
  if (snapshot.kdj && monitorValues?.kdj !== snapshot.kdj) {
    kdjObjectPool.release(snapshot.kdj);
  }

  // 释放 MACD 对象（如果它没有被 monitorValues 引用）
  if (snapshot.macd && monitorValues?.macd !== snapshot.macd) {
    macdObjectPool.release(snapshot.macd);
  }
}

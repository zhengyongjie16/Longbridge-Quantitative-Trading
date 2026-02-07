/**
 * 工具函数模块
 *
 * 功能：
 * - 标的代码格式校验（ticker.region）
 * - Decimal 类型转换
 * - 时间格式化（北京时区）
 * - 数值格式化
 * - 监控状态管理
 *
 * 核心函数：
 * - isSymbolWithRegion()：校验标的代码格式
 * - decimalToNumber() / toDecimal()：LongPort Decimal 类型转换
 * - toBeijingTimeIso() / toBeijingTimeLog()：UTC 到北京时间转换
 * - formatSymbolDisplay() / formatQuoteDisplay()：格式化显示
 * - formatError()：安全格式化错误对象
 * - isDefined() / isValidPositiveNumber()：类型检查辅助函数
 * - isBuyAction() / isSellAction()：信号动作判断
 * - sleep()：异步延迟函数
 * - initMonitorState() / releaseSnapshotObjects()：监控状态管理
 */
import type {
  IndicatorSnapshot,
  MonitorConfig,
  MonitorState,
  SignalType,
} from '../../types/index.js';
import { inspect } from 'node:util';
import { Decimal } from 'longport';
import { TIME, SYMBOL_WITH_REGION_REGEX, ACCOUNT_CHANNEL_MAP } from '../../constants/index.js';
import type { DecimalLike, QuoteDisplayResult, TimeFormatOptions } from './types.js';
import { logger } from '../logger/index.js';
import { kdjObjectPool, macdObjectPool } from '../objectPool/index.js';

/**
 * 检查值是否已定义（不是 null 或 undefined）
 * @param value 待检查的值
 * @returns 如果值不是 null 或 undefined 返回 true，否则返回 false
 */
export function isDefined<T>(value: T | null | undefined): value is T {
  return value != null; // != null 会同时检查 null 和 undefined
}

/**
 * 类型保护：检查是否为 Error 实例（内部使用）
 * @param value 待检查的值
 * @returns 如果是 Error 实例返回 true
 */
function isError(value: unknown): value is Error {
  return value instanceof Error;
}

/**
 * 类型保护：检查是否为类似错误的对象（内部使用）
 * @param value 待检查的值
 * @returns 如果对象包含常见错误属性返回 true
 */
function isErrorLike(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return typeof obj['message'] === 'string' ||
         typeof obj['error'] === 'string' ||
         typeof obj['msg'] === 'string' ||
         typeof obj['code'] === 'string';
}


/**
 * 校验标的代码格式（ticker.region）
 * @param symbol 标的代码，例如 "68547.HK"
 * @returns 是否符合 ticker.region 格式
 */
export function isSymbolWithRegion(symbol: string | null | undefined): symbol is string {
  if (!symbol || typeof symbol !== 'string') {
    return false;
  }
  return SYMBOL_WITH_REGION_REGEX.test(symbol);
}

/**
 * 将值转换为 LongPort Decimal 类型
 * @param value 要转换的值（number、string 或已存在的 Decimal）
 * @returns Decimal 对象，如果值无效则返回 Decimal.ZERO()
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
 * 将 Decimal 类型转换为数字
 * @param decimalLike Decimal 对象或数字
 * @returns 转换后的数字，如果输入为 null/undefined 返回 NaN（便于后续 Number.isFinite() 检查）
 */
export function decimalToNumber(decimalLike: DecimalLike | number | string | null | undefined): number {
  // 如果输入为 null 或 undefined，返回 NaN 而非 0
  // 这样 Number.isFinite() 检查会返回 false，避免错误地使用 0 作为有效值
  if (decimalLike === null || decimalLike === undefined) {
    return Number.NaN;
  }
  if (typeof decimalLike === 'object' && 'toNumber' in decimalLike) {
    return decimalLike.toNumber();
  }
  return Number(decimalLike);
}

/**
 * 检查值是否为有效的正数（有限且大于0）
 * @param value 待检查的值
 * @returns 如果值为有效的正数返回 true，否则返回 false
 */
export function isValidPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
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
  return Number.isFinite(num) ? num.toFixed(digits) : String(num);
}

/**
 * 账户渠道映射表
 */
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
  if (ACCOUNT_CHANNEL_MAP[lowerChannel]) {
    return ACCOUNT_CHANNEL_MAP[lowerChannel];
  }

  // 否则返回原始值
  return accountChannel;
}


/**
 * 格式化标的显示：中文名称(代码)
 * @param symbol 标的代码
 * @param symbolName 标的中文名称（可选）
 * @returns 格式化后的标的显示
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

function toBeijingTime(date: Date | null = null, options: TimeFormatOptions = {}): string {
  const { format = 'iso' } = options;
  const targetDate = date || new Date();
  // 转换为北京时间（UTC+8）
  const beijingOffset = TIME.BEIJING_TIMEZONE_OFFSET_MS;
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
 * 格式化行情数据显示
 * @param quote 行情对象
 * @param symbol 标的代码
 * @returns 格式化后的行情显示对象，如果quote无效则返回null
 */
export function formatQuoteDisplay(quote: import('../../types/index.js').Quote | null, symbol: string): QuoteDisplayResult | null {
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
 * 格式化标的显示字符串（从行情对象生成）
 * 如果 quote 存在，返回 "中文名称(代码)" 格式；否则返回原始代码
 * @param quote 行情对象（可选）
 * @param symbol 标的代码
 * @returns 格式化后的标的显示字符串
 */
export function formatSymbolDisplayFromQuote(quote: import('../../types/index.js').Quote | null | undefined, symbol: string): string {
  if (quote) {
    const display = formatQuoteDisplay(quote, symbol);
    return display ? `${display.nameText}(${display.codeText})` : symbol;
  }
  return symbol;
}



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

/** 获取做多标的方向名称 */
export function getLongDirectionName(): string {
  return '做多标的';
}

/** 获取做空标的方向名称 */
export function getShortDirectionName(): string {
  return '做空标的';
}

/**
 * 格式化信号操作描述（内部使用）
 */
function getSignalActionDescription(action: SignalType): string {
  const descriptions: Record<SignalType, string> = {
    'BUYCALL': '买入做多标的（做多）',
    'SELLCALL': '卖出做多标的（清仓）',
    'BUYPUT': '买入做空标的（做空）',
    'SELLPUT': '卖出做空标的（平空仓）',
    'HOLD': '持有',
  };

  return descriptions[action] || `未知操作(${action})`;
}

/**
 * 格式化信号日志（标的显示为：中文名称(代码)）
 */
export function formatSignalLog(signal: { action: SignalType; symbol: string; symbolName?: string | null; reason?: string | null }): string {
  const actionDesc = getSignalActionDescription(signal.action);
  const symbolDisplay = formatSymbolDisplay(signal.symbol, signal.symbolName ?? null);
  return `${actionDesc} ${symbolDisplay} - ${signal.reason || '策略信号'}`;
}


/**
 * 格式化错误对象为可读字符串
 * 避免使用 String(err) 导致普通对象返回 '[object Object]'
 * @param err 错误对象
 * @returns 格式化后的错误消息
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
 * 主程序循环间隔
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
 * 初始化监控标的状态
 * @param config 监控配置
 * @returns 初始化的监控状态
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
  };
}

/**
 * 释放快照中的 KDJ 和 MACD 对象（如果它们没有被 monitorValues 引用）
 * @param snapshot 要释放的快照
 * @param monitorValues 监控值对象，用于检查引用
 */
export function releaseSnapshotObjects(
  snapshot: IndicatorSnapshot | null,
  monitorValues: MonitorState['monitorValues'],
): void {
  if (!snapshot) {
    return;
  }

  // 释放 KDJ 对象（如果它没有被 monitorValues 引用）
  if (snapshot.kdj && monitorValues?.kdj !== snapshot.kdj) {
    kdjObjectPool.release(snapshot.kdj);
  }

  // 释放 MACD 对象（如果它没有被 monitorValues 引用）
  if (snapshot.macd && monitorValues?.macd !== snapshot.macd) {
    macdObjectPool.release(snapshot.macd);
  }
}


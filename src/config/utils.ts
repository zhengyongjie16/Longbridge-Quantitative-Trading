import type { OrderType } from 'longport';
import {
  ORDER_TYPE_CONFIG_TO_OPEN_API,
  SIGNAL_CONFIG_SUPPORTED_INDICATORS,
  SYMBOL_WITH_REGION_REGEX,
  VERIFICATION_FIXED_INDICATORS,
} from '../constants/index.js';
import type { LiquidationCooldownConfig, NumberRange } from '../types/config.js';
import type { OrderTypeConfig } from '../types/signal.js';
import type { ConditionGroup, SignalConfig } from '../types/signalConfig.js';
import {
  validateEmaPeriod,
  validatePsyPeriod,
  validateRsiPeriod,
} from '../utils/indicatorHelpers/index.js';
import { logger } from '../utils/logger/index.js';
import type {
  ComparisonOperator,
  ParsedCondition,
  ParsedConditionGroup,
  RegionUrls,
} from './types.js';

/**
 * 根据区域返回对应的 LongPort API 端点 URL，cn 使用 .cn 域名，其他区域使用 .com 域名。
 * @param region - 区域标识字符串（如 'cn'、'hk'），未传入时默认为 'hk'
 * @returns 包含 httpUrl、quoteWsUrl、tradeWsUrl 的端点对象
 */
export function getRegionUrls(region: string | undefined): RegionUrls {
  const normalizedRegion = (region === '' ? 'hk' : (region ?? 'hk')).toLowerCase();

  if (normalizedRegion === 'cn') {
    // 中国大陆区域
    return {
      httpUrl: 'https://openapi.longportapp.cn',
      quoteWsUrl: 'wss://openapi-quote.longportapp.cn/v2',
      tradeWsUrl: 'wss://openapi-trade.longportapp.cn/v2',
    };
  }

  // 香港及其他地区（默认）
  return {
    httpUrl: 'https://openapi.longportapp.com',
    quoteWsUrl: 'wss://openapi-quote.longportapp.com/v2',
    tradeWsUrl: 'wss://openapi-trade.longportapp.com/v2',
  };
}

/**
 * 读取字符串配置，未设置、空串或占位符（形如 your_xxx_here）时返回 null。
 * @param env - 进程环境变量对象
 * @param envKey - 环境变量键名
 * @returns 去除首尾空白后的字符串，或 null
 */
export function getStringConfig(env: NodeJS.ProcessEnv, envKey: string): string | null {
  const value = env[envKey];
  if (!value || value.trim() === '' || value === `your_${envKey.toLowerCase()}_here`) {
    return null;
  }
  return value.trim();
}

/**
 * 读取数字配置，未设置、非有限数或小于最小值时返回 null。
 * @param env - 进程环境变量对象
 * @param envKey - 环境变量键名
 * @param minValue - 允许的最小值，默认为 0
 * @returns 解析后的数字，或 null
 */
export function getNumberConfig(
  env: NodeJS.ProcessEnv,
  envKey: string,
  minValue: number = 0,
): number | null {
  const value = env[envKey];
  if (!value || value.trim() === '') {
    return null;
  }
  const num = Number(value);
  if (!Number.isFinite(num) || num < minValue) {
    return null;
  }
  return num;
}

/**
 * 读取布尔配置，仅识别 'true'/'false'，其他值返回默认值。
 * @param env - 进程环境变量对象
 * @param envKey - 环境变量键名
 * @param defaultValue - 未设置或无法识别时的默认值，默认为 false
 * @returns 解析后的布尔值
 */
export function getBooleanConfig(
  env: NodeJS.ProcessEnv,
  envKey: string,
  defaultValue: boolean = false,
): boolean {
  const value = env[envKey];
  if (value === undefined || value.trim() === '') {
    return defaultValue;
  }
  const normalizedValue = value.trim().toLowerCase();
  if (normalizedValue === 'true') {
    return true;
  }
  if (normalizedValue === 'false') {
    return false;
  }
  return defaultValue;
}

/**
 * 解析保护性清仓冷却配置，支持 minutes / half-day / one-day 三种模式。
 * @param env - 进程环境变量对象
 * @param envKey - 环境变量键名
 * @returns 解析后的冷却配置对象，无效或未设置时返回 null
 */
export function parseLiquidationCooldownConfig(
  env: NodeJS.ProcessEnv,
  envKey: string,
): LiquidationCooldownConfig | null {
  const value = getStringConfig(env, envKey);
  if (!value) {
    return null;
  }
  const normalizedValue = value.trim().toLowerCase();
  if (normalizedValue === 'half-day') {
    return { mode: 'half-day' };
  }
  if (normalizedValue === 'one-day') {
    return { mode: 'one-day' };
  }

  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 120) {
    return null;
  }
  return { mode: 'minutes', minutes };
}

/**
 * 解析智能平仓超时分钟配置，支持空值/null（关闭）或非负整数分钟。
 * @param env - 进程环境变量对象
 * @param envKey - 环境变量键名
 * @returns 合法时返回非负整数或 null；非法值返回 null（由 validator 报错）
 */
export function parseSmartCloseTimeoutMinutesConfig(
  env: NodeJS.ProcessEnv,
  envKey: string,
): number | null {
  const raw = env[envKey];
  if (raw === undefined) {
    return null;
  }

  const trimmed = raw.trim();
  if (trimmed === '') {
    return null;
  }

  if (trimmed.toLowerCase() === 'null') {
    return null;
  }

  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 0) {
    return null;
  }

  return value;
}

/**
 * 解析数值范围配置，格式为 "min,max"。
 * @param env - 进程环境变量对象
 * @param envKey - 环境变量键名
 * @returns 解析后的 NumberRange 对象，格式无效或未设置时返回 null
 */
export function parseNumberRangeConfig(env: NodeJS.ProcessEnv, envKey: string): NumberRange | null {
  const value = getStringConfig(env, envKey);
  if (!value) {
    return null;
  }

  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.length !== 2) {
    logger.warn(`[配置警告] ${envKey} 格式无效，必须为 "min,max"`);
    return null;
  }

  const min = Number(parts[0]);
  const max = Number(parts[1]);

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    logger.warn(`[配置警告] ${envKey} 格式无效，min/max 必须为数字`);
    return null;
  }

  if (min > max) {
    logger.warn(`[配置警告] ${envKey} 格式无效，min 不能大于 max`);
    return null;
  }

  return { min, max };
}

/**
 * 解析订单归属映射，从逗号分隔的缩写列表中提取唯一缩写，按长度降序排列。
 * @param env - 进程环境变量对象
 * @param envKey - 环境变量键名
 * @returns 去重并排序后的缩写数组，未设置或为空时返回空数组
 */
export function parseOrderOwnershipMapping(
  env: NodeJS.ProcessEnv,
  envKey: string,
): ReadonlyArray<string> {
  const value = getStringConfig(env, envKey);
  if (!value) {
    return [];
  }

  const items = value
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter((item) => item !== '');

  if (items.length === 0) {
    logger.warn(`[配置警告] ${envKey} 未包含有效缩写`);
    return [];
  }

  const uniqueItems = [...new Set(items)];
  uniqueItems.sort((a, b) => b.length - a.length || a.localeCompare(b));

  return uniqueItems;
}

/**
 * 解析延迟验证时间（秒），范围 0-120，超出上限时截断为 120。
 * @param env - 进程环境变量对象
 * @param envKey - 环境变量键名
 * @param defaultValue - 未设置或无效时的默认值
 * @returns 解析后的延迟秒数
 */
export function parseVerificationDelay(
  env: NodeJS.ProcessEnv,
  envKey: string,
  defaultValue: number,
): number {
  // getNumberConfig(env, envKey, 0) 已拒绝负值（minValue=0），此处仅需检查上限
  const delay = getNumberConfig(env, envKey, 0);
  if (delay === null) {
    return defaultValue;
  }
  if (delay > 120) {
    logger.warn(`[配置警告] ${envKey} 不能大于 120，已设置为 120`);
    return 120;
  }
  return delay;
}

/**
 * 解析延迟验证指标列表，支持 K/D/J/MACD/DIF/DEA/EMA:N/PSY:N，无效项记录警告后跳过。
 * @param env - 进程环境变量对象
 * @param envKey - 环境变量键名
 * @returns 有效指标字符串数组，未设置或全部无效时返回 null
 */
export function parseVerificationIndicators(
  env: NodeJS.ProcessEnv,
  envKey: string,
): ReadonlyArray<string> | null {
  const value = env[envKey];
  if (!value || value.trim() === '') {
    return null;
  }

  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');

  if (items.length === 0) {
    return null;
  }

  const validItems: string[] = [];
  const invalidItems: string[] = [];

  /**
   * 解析带周期的指标并加入有效列表，无效时加入 invalidItems。
   * @param item - 原始指标字符串（如 'EMA:12'、'PSY:12'）
   * @param prefix - 指标前缀（'PSY:' 或 'EMA:'）
   * @param validator - 周期校验函数，通过则视为有效
   * @returns 是否已处理该 item（true 表示匹配前缀并已加入 validItems 或 invalidItems）
   */
  function tryParseIndicatorWithPeriod(
    item: string,
    prefix: 'PSY:' | 'EMA:',
    validator: (period: number) => boolean,
  ): boolean {
    if (!item.startsWith(prefix)) {
      return false;
    }
    const period = Number.parseInt(item.slice(prefix.length), 10);
    if (validator(period)) {
      validItems.push(item);
      return true;
    }
    invalidItems.push(item);
    return true;
  }

  for (const item of items) {
    if (VERIFICATION_FIXED_INDICATORS.has(item)) {
      validItems.push(item);
      continue;
    }

    if (tryParseIndicatorWithPeriod(item, 'PSY:', validatePsyPeriod)) {
      continue;
    }
    if (tryParseIndicatorWithPeriod(item, 'EMA:', validateEmaPeriod)) {
      continue;
    }
    invalidItems.push(item);
  }

  if (invalidItems.length > 0) {
    logger.warn(`[配置警告] ${envKey} 包含无效值: ${invalidItems.join(', ')}`);
  }

  return validItems.length > 0 ? validItems : null;
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
 * 类型保护：判断字符串是否为支持的比较运算符（< 或 >）。
 *
 * @param value 待判断字符串
 * @returns true 表示是合法比较运算符
 */
function isComparisonOperator(value: string): value is ComparisonOperator {
  return value === '<' || value === '>';
}

/**
 * 类型保护：判断字符串是否为支持的固定指标（不含 RSI/PSY 动态周期指标）。
 *
 * @param value 指标名称
 * @returns true 表示属于固定指标集合
 */
function isSupportedFixedIndicator(
  value: string,
): value is (typeof SIGNAL_CONFIG_SUPPORTED_INDICATORS)[number] {
  const supportedIndicators: ReadonlyArray<string> = SIGNAL_CONFIG_SUPPORTED_INDICATORS;
  return supportedIndicators.includes(value);
}

/**
 * 解析单个信号条件字符串，支持 RSI:n、PSY:n 及固定指标（K、D、J、MFI 等）格式。
 *
 * @param conditionStr 条件字符串，如 "RSI:6<20"、"PSY:12<25"、"J<-1"
 * @returns 解析后的 ParsedCondition，格式无效时返回 null
 */
function parseCondition(conditionStr: string): ParsedCondition | null {
  const trimmed = conditionStr.trim();
  if (!trimmed) {
    return null;
  }

  const rsiRegex = /^RSI:(\d+)\s*([<>])\s*(-?\d+(?:\.\d+)?)$/;
  const rsiMatch = rsiRegex.exec(trimmed);

  if (rsiMatch) {
    const [, periodStr, operator, thresholdStr] = rsiMatch;

    if (!periodStr || !operator || !thresholdStr) {
      return null;
    }

    const period = Number.parseInt(periodStr, 10);
    const threshold = Number.parseFloat(thresholdStr);
    if (
      !validateRsiPeriod(period) ||
      !Number.isFinite(threshold) ||
      !isComparisonOperator(operator)
    ) {
      return null;
    }
    return { indicator: 'RSI', period, operator, threshold };
  }

  const psyRegex = /^PSY:(\d+)\s*([<>])\s*(-?\d+(?:\.\d+)?)$/;
  const psyMatch = psyRegex.exec(trimmed);

  if (psyMatch) {
    const [, periodStr, operator, thresholdStr] = psyMatch;

    if (!periodStr || !operator || !thresholdStr) {
      return null;
    }

    const period = Number.parseInt(periodStr, 10);
    const threshold = Number.parseFloat(thresholdStr);
    if (
      !validatePsyPeriod(period) ||
      !Number.isFinite(threshold) ||
      !isComparisonOperator(operator)
    ) {
      return null;
    }
    return { indicator: 'PSY', period, operator, threshold };
  }

  const matchRegex = /^([A-Z]+)\s*([<>])\s*(-?\d+(?:\.\d+)?)$/;
  const match = matchRegex.exec(trimmed);
  if (!match) {
    return null;
  }

  const [, indicator, operator, thresholdStr] = match;
  if (!indicator || !operator || !thresholdStr) {
    return null;
  }

  const threshold = Number.parseFloat(thresholdStr);
  if (
    !isSupportedFixedIndicator(indicator) ||
    !Number.isFinite(threshold) ||
    !isComparisonOperator(operator)
  ) {
    return null;
  }
  return { indicator, operator, threshold };
}

/**
 * 解析条件组字符串，支持 "(条件列表)/N" 或 "(条件列表)" 格式，逗号分隔多条件。
 *
 * @param groupStr 条件组字符串，如 "(RSI:6<20,MFI<15,D<20,J<-1)/3" 或 "(J<-20)"
 * @returns 解析后的 ParsedConditionGroup（conditions + minSatisfied），格式无效时返回 null
 */
function parseConditionGroup(groupStr: string): ParsedConditionGroup | null {
  const trimmed = groupStr.trim();
  if (!trimmed) {
    return null;
  }

  let conditionsStr: string;
  let minSatisfied: number | null = null;

  const bracketRegex = /^\(([^)]+)\)(?:\/(\d+))?$/;
  const bracketMatch = bracketRegex.exec(trimmed);

  if (bracketMatch) {
    const capturedConditions = bracketMatch[1];
    if (!capturedConditions) {
      return null;
    }
    conditionsStr = capturedConditions;
    const minSatisfiedStr = bracketMatch[2];
    minSatisfied = minSatisfiedStr ? Number.parseInt(minSatisfiedStr, 10) : null;
  } else {
    conditionsStr = trimmed;
  }

  const conditionStrs = conditionsStr.split(',');
  const conditions: ParsedCondition[] = [];

  for (const condStr of conditionStrs) {
    const condition = parseCondition(condStr);
    if (!condition) {
      return null;
    }
    conditions.push(condition);
  }

  if (conditions.length === 0) {
    return null;
  }

  minSatisfied ??= conditions.length;
  if (minSatisfied < 1 || minSatisfied > conditions.length) {
    minSatisfied = Math.max(1, Math.min(minSatisfied, conditions.length));
  }

  return {
    conditions,
    minSatisfied,
  };
}

/**
 * 将配置字符串解析为 SignalConfig。默认行为：空字符串或非字符串返回 null；最多解析 3 个条件组（| 分隔）；任一条件组解析失败则整体返回 null。
 *
 * @param configStr 配置字符串，如 "(RSI:6<20,MFI<15,D<20,J<-1)/3|(J<-20)"
 * @returns 解析后的 SignalConfig，无效时返回 null
 */
export function parseSignalConfig(configStr: string | null | undefined): SignalConfig | null {
  if (!configStr || typeof configStr !== 'string') {
    return null;
  }

  const trimmed = configStr.trim();
  if (!trimmed) {
    return null;
  }

  const groupStrs = trimmed.split('|');
  const conditionGroups: ConditionGroup[] = [];

  for (let i = 0; i < Math.min(groupStrs.length, 3); i++) {
    const groupStr = groupStrs[i];
    if (!groupStr) {
      continue;
    }
    const group = parseConditionGroup(groupStr);
    if (!group) {
      return null;
    }
    conditionGroups.push({
      conditions: group.conditions.map((condition) => ({
        indicator: condition.period
          ? `${condition.indicator}:${condition.period}`
          : condition.indicator,
        operator: condition.operator,
        threshold: condition.threshold,
      })),
      requiredCount: group.minSatisfied,
    });
  }

  if (conditionGroups.length === 0) {
    return null;
  }

  return {
    conditionGroups,
  };
}

/**
 * 将信号配置格式化为可读字符串（与配置格式一致）。默认行为：无效配置返回 "(无效配置)"。
 *
 * @param signalConfig 信号配置
 * @returns 可读字符串，如 "(RSI:6<20,MFI<15)/3|(J<-20)"
 */
export function formatSignalConfig(signalConfig: SignalConfig | null): string {
  if (!signalConfig?.conditionGroups) {
    return '(无效配置)';
  }

  const groups = signalConfig.conditionGroups.map((group) => {
    const conditions = group.conditions
      .map((condition) => `${condition.indicator}${condition.operator}${condition.threshold}`)
      .join(',');

    if (group.conditions.length === 1) {
      return `(${conditions})`;
    }

    const minSatisfied = group.requiredCount ?? group.conditions.length;
    if (minSatisfied === group.conditions.length) {
      return `(${conditions})`;
    }

    return `(${conditions})/${minSatisfied}`;
  });

  return groups.join('|');
}

/**
 * 类型保护：判断字符串是否为受支持的订单类型配置代码。
 * @param value 待判断的字符串
 * @returns true 表示值属于 OrderTypeConfig
 */
function isOrderTypeConfig(value: string): value is OrderTypeConfig {
  return Object.hasOwn(ORDER_TYPE_CONFIG_TO_OPEN_API, value);
}

/**
 * 解析订单类型配置（LO/ELO/MO），必须大写，无效时回退默认值。
 * @param env - 进程环境变量对象
 * @param envKey - 环境变量键名
 * @param defaultType - 无效或未设置时的默认订单类型，默认为 'ELO'
 * @returns 对应的 OrderType 枚举值
 */
export function parseOrderTypeConfig(
  env: NodeJS.ProcessEnv,
  envKey: string,
  defaultType: OrderTypeConfig = 'ELO',
): OrderType {
  // getStringConfig 已处理 trim 和占位符
  const value = getStringConfig(env, envKey);
  if (value) {
    if (isOrderTypeConfig(value)) {
      return ORDER_TYPE_CONFIG_TO_OPEN_API[value];
    }
    logger.warn(
      `[配置警告] ${envKey} 值无效: ${value}，必须使用全大写: LO, ELO, MO。已使用默认值: ${defaultType}`,
    );
  }
  return ORDER_TYPE_CONFIG_TO_OPEN_API[defaultType];
}

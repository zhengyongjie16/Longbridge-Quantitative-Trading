import { OrderType } from 'longport';
import type { LiquidationCooldownConfig, NumberRange } from '../types/config.js';
import { validateEmaPeriod, validatePsyPeriod } from '../utils/helpers/indicatorHelpers.js';
import { logger } from '../utils/logger/index.js';
import type { RegionUrls } from './types.js';

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

  const uniqueItems = Array.from(new Set(items));
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

// 固定指标无需周期参数
const FIXED_INDICATORS = new Set(['K', 'D', 'J', 'MACD', 'DIF', 'DEA']);

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
    if (FIXED_INDICATORS.has(item)) {
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

/** 订单类型字符串到枚举的映射 */
const ORDER_TYPE_MAPPING: Readonly<Record<string, OrderType>> = {
  LO: OrderType.LO,
  ELO: OrderType.ELO,
  MO: OrderType.MO,
};

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
  defaultType: 'LO' | 'ELO' | 'MO' = 'ELO',
): OrderType {
  // getStringConfig 已处理 trim 和占位符
  const value = getStringConfig(env, envKey);
  if (value) {
    const parsed = ORDER_TYPE_MAPPING[value];
    if (parsed) {
      return parsed;
    }
    logger.warn(
      `[配置警告] ${envKey} 值无效: ${value}，必须使用全大写: LO, ELO, MO。已使用默认值: ${defaultType}`,
    );
  }
  return ORDER_TYPE_MAPPING[defaultType] ?? OrderType.ELO;
}

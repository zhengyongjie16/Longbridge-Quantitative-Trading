/**
 * 配置模块工具函数
 *
 * 提供环境变量读取、解析和转换的工具函数
 */

import { OrderType } from 'longport';
import type { LiquidationCooldownConfig, NumberRange } from '../types/index.js';
import { validateEmaPeriod, validatePsyPeriod } from '../utils/helpers/indicatorHelpers.js';
import { logger } from '../utils/logger/index.js';
import type { RegionUrls } from './types.js';

/** 根据区域获取 API 端点 URL（cn 使用 .cn 域名，其他使用 .com） */
export function getRegionUrls(region: string | undefined): RegionUrls {
  const normalizedRegion = (region || 'hk').toLowerCase();

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

/** 读取字符串配置，未设置或为占位符时返回 null */
export function getStringConfig(
  env: NodeJS.ProcessEnv,
  envKey: string,
): string | null {
  const value = env[envKey];
  if (
    !value ||
    value.trim() === '' ||
    value === `your_${envKey.toLowerCase()}_here`
  ) {
    return null;
  }
  return value.trim();
}

/** 读取数字配置，未设置或小于最小值时返回 null */
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

/** 读取布尔配置，仅识别 'true'/'false'，其他返回默认值 */
export function getBooleanConfig(
  env: NodeJS.ProcessEnv,
  envKey: string,
  defaultValue: boolean = false,
): boolean {
  const value = env[envKey];
  if (value === undefined || value === null || value.trim() === '') {
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

/** 解析保护性清仓冷却配置（支持 minutes / half-day / one-day） */
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

/** 解析数值范围配置（格式：min,max） */
export function parseNumberRangeConfig(
  env: NodeJS.ProcessEnv,
  envKey: string,
): NumberRange | null {
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

/** 解析订单归属映射（逗号分隔缩写列表） */
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
  uniqueItems.sort((a, b) => {
    if (a.length !== b.length) {
      return b.length - a.length;
    }
    return a.localeCompare(b);
  });

  return uniqueItems;
}

/** 解析延迟验证时间（秒），范围 0-120 */
export function parseVerificationDelay(
  env: NodeJS.ProcessEnv,
  envKey: string,
  defaultValue: number,
): number {
  const delay = getNumberConfig(env, envKey, 0);
  if (delay === null) {
    return defaultValue;
  }
  if (delay < 0) {
    logger.warn(`[配置警告] ${envKey} 不能小于 0，已设置为 0`);
    return 0;
  }
  if (delay > 120) {
    logger.warn(`[配置警告] ${envKey} 不能大于 120，已设置为 120`);
    return 120;
  }
  return delay;
}

// 固定指标无需周期参数
const FIXED_INDICATORS = new Set(['K', 'D', 'J', 'MACD', 'DIF', 'DEA']);

/** 解析延迟验证指标列表（支持 K/D/J/MACD/DIF/DEA/EMA:N/PSY:N） */
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
   * 解析带周期的指标并加入有效列表，返回 true 表示已处理。
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

/** 解析订单类型配置（LO/ELO/MO），必须大写 */
export function parseOrderTypeConfig(
  env: NodeJS.ProcessEnv,
  envKey: string,
  defaultType: 'LO' | 'ELO' | 'MO' = 'ELO',
): OrderType {
  const value = getStringConfig(env, envKey);
  const trimmedValue = value ? value.trim() : null;
  const mapping: Record<string, OrderType> = {
    LO: OrderType.LO,
    ELO: OrderType.ELO,
    MO: OrderType.MO,
  };
  const parsed = trimmedValue ? mapping[trimmedValue] : undefined;
  if (parsed) {
    return parsed;
  }
  if (value && trimmedValue !== 'LO' && trimmedValue !== 'ELO' && trimmedValue !== 'MO') {
    logger.warn(
      `[配置警告] ${envKey} 值无效: ${value}，必须使用全大写: LO, ELO, MO。已使用默认值: ${defaultType}`,
    );
  }
  if (defaultType === 'LO') {
    return OrderType.LO;
  }
  if (defaultType === 'MO') {
    return OrderType.MO;
  }
  return OrderType.ELO;
}

/**
 * 配置模块工具函数
 *
 * 提供环境变量读取、解析和转换的工具函数
 */

import { OrderType } from 'longport';
import { validateEmaPeriod, validatePsyPeriod } from '../utils/helpers/indicatorHelpers.js';
import { logger } from '../utils/logger/index.js';
import type { RegionUrls } from './types.js';

/** 根据区域获取 API 端点 URL（cn 使用 .cn 域名，其他使用 .com） */
export const getRegionUrls = (region: string | undefined): RegionUrls => {
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
};

/** 读取字符串配置，未设置或为占位符时返回 null */
export const getStringConfig = (
  env: NodeJS.ProcessEnv,
  envKey: string,
): string | null => {
  const value = env[envKey];
  if (
    !value ||
    value.trim() === '' ||
    value === `your_${envKey.toLowerCase()}_here`
  ) {
    return null;
  }
  return value.trim();
};

/** 读取数字配置，未设置或小于最小值时返回 null */
export const getNumberConfig = (
  env: NodeJS.ProcessEnv,
  envKey: string,
  minValue: number = 0,
): number | null => {
  const value = env[envKey];
  if (!value || value.trim() === '') {
    return null;
  }
  const num = Number(value);
  if (!Number.isFinite(num) || num < minValue) {
    return null;
  }
  return num;
};

/** 读取布尔配置，仅识别 'true'/'false'，其他返回默认值 */
export const getBooleanConfig = (
  env: NodeJS.ProcessEnv,
  envKey: string,
  defaultValue: boolean = false,
): boolean => {
  const value = env[envKey];
  // 如果环境变量未设置或为空，返回默认值
  if (value === undefined || value === null || value.trim() === '') {
    return defaultValue;
  }
  // 显式检查 "true" 和 "false"
  if (value.toLowerCase() === 'true') {
    return true;
  }
  if (value.toLowerCase() === 'false') {
    return false;
  }
  // 其他值返回默认值
  return defaultValue;
};

/** 解析延迟验证时间（秒），范围 0-120 */
export const parseVerificationDelay = (
  env: NodeJS.ProcessEnv,
  envKey: string,
  defaultValue: number,
): number => {
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
};

/** 解析延迟验证指标列表（支持 K/D/J/MACD/DIF/DEA/EMA:N/PSY:N） */
export const parseVerificationIndicators = (
  env: NodeJS.ProcessEnv,
  envKey: string,
): ReadonlyArray<string> | null => {
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

  const fixedIndicators = new Set(['K', 'D', 'J', 'MACD', 'DIF', 'DEA']);
  const validItems: string[] = [];
  const invalidItems: string[] = [];

  for (const item of items) {
    if (fixedIndicators.has(item)) {
      validItems.push(item);
      continue;
    }

    if (item.startsWith('PSY:')) {
      const periodStr = item.substring(4);
      const period = Number.parseInt(periodStr, 10);

      if (validatePsyPeriod(period)) {
        validItems.push(item);
        continue;
      }

      invalidItems.push(item);
      continue;
    }

    if (item.startsWith('EMA:')) {
      const periodStr = item.substring(4);
      const period = Number.parseInt(periodStr, 10);

      if (validateEmaPeriod(period)) {
        validItems.push(item);
        continue;
      }

      invalidItems.push(item);
    } else {
      invalidItems.push(item);
    }
  }

  if (invalidItems.length > 0) {
    logger.warn(`[配置警告] ${envKey} 包含无效值: ${invalidItems.join(', ')}`);
  }

  return validItems.length > 0 ? validItems : null;
};

/** 解析订单类型配置（LO/ELO/MO），必须大写 */
export const parseOrderTypeConfig = (
  env: NodeJS.ProcessEnv,
  envKey: string,
  defaultType: 'LO' | 'ELO' | 'MO' = 'ELO',
): OrderType => {
  const value = getStringConfig(env, envKey);

  // 验证配置值（必须使用全大写，区分大小写）
  const trimmedValue = value ? value.trim() : null;

  if (trimmedValue === 'LO') {
    return OrderType.LO;
  }
  if (trimmedValue === 'ELO') {
    return OrderType.ELO;
  }
  if (trimmedValue === 'MO') {
    return OrderType.MO;
  }

  // 如果配置值无效或未配置，使用默认值
  if (value && trimmedValue !== 'LO' && trimmedValue !== 'ELO' && trimmedValue !== 'MO') {
    logger.warn(
      `[配置警告] ${envKey} 值无效: ${value}，必须使用全大写: LO, ELO, MO。已使用默认值: ${defaultType}`,
    );
  }

  // 返回默认值
  if (defaultType === 'LO') {
    return OrderType.LO;
  }
  if (defaultType === 'MO') {
    return OrderType.MO;
  }
  return OrderType.ELO;
};

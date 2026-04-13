import type { OrderType } from 'longbridge';
import type { MonitorConfig } from '../../types/config.js';
import type { OrderTypeConfig } from '../../types/signal.js';
import type { SignalConfig } from '../../types/signalConfig.js';
import { logger } from '../../utils/logger/index.js';
import { OPEN_API_ORDER_TYPE_TO_CONFIG } from '../../constants/index.js';
import {
  createConfigValidationError,
  getBooleanConfig,
  getNumberConfig,
  getStringConfig,
  parseLiquidationCooldownConfig,
  parseNumberRangeConfig,
  parseOrderOwnershipMapping,
  parseOrderTypeConfig,
  parseSignalConfig,
  parseSmartCloseTimeoutMinutesConfig,
  parseVerificationDelay,
  parseVerificationIndicators,
} from '../utils.js';
import type { BoundedNumberConfig, MinimumNumberConfig } from './types.js';

/**
 * 从环境变量解析信号配置字符串，未配置或解析失败时返回 null。
 * @param env 进程环境变量对象
 * @param envKey 环境变量键名
 * @returns 解析后的信号配置，无效时返回 null
 */
function parseSignalConfigFromEnv(env: NodeJS.ProcessEnv, envKey: string): SignalConfig | null {
  const configStr = getStringConfig(env, envKey);
  if (!configStr) {
    return null;
  }

  const config = parseSignalConfig(configStr);
  if (!config) {
    logger.error(`[配置错误] ${envKey} 格式无效`);
    return null;
  }

  return config;
}

/**
 * 解析带上下限的数值配置。
 * @param options 包含 env、envKey、defaultValue、min、max 的配置对象
 * @returns 未配置或非法时返回 defaultValue；可解析但低于 min 时收敛到 min；高于 max 时收敛到 max
 */
function parseBoundedNumberConfig({
  env,
  envKey,
  defaultValue,
  min,
  max,
}: BoundedNumberConfig): number {
  const value = getNumberConfig(env, envKey, 0);
  if (value === null) {
    return defaultValue;
  }

  if (value < min) {
    logger.warn(`[配置警告] ${envKey} 不能小于 ${min}，已设置为 ${min}`);
    return min;
  }

  if (value > max) {
    logger.warn(`[配置警告] ${envKey} 不能大于 ${max}，已设置为 ${max}`);
    return max;
  }

  return value;
}

/**
 * 解析关键数值配置：未配置时使用默认值，显式配置非法或越界时立即失败。
 * @param options 包含 env、envKey、defaultValue、min、max 的配置对象
 * @returns 合法范围内的数值
 */
export function parseFailFastBoundedNumberConfig({
  env,
  envKey,
  defaultValue,
  min,
  max,
}: BoundedNumberConfig): number {
  const raw = env[envKey];
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw createConfigValidationError(
      `[配置错误] ${envKey} 无效（必须为数字，范围 ${min}-${max}）`,
      [envKey],
    );
  }

  return value;
}

/**
 * 解析关键数值配置：未配置时使用默认值，显式配置非法或小于下限时立即失败。
 * @param options 包含 env、envKey、defaultValue、min 的配置对象
 * @returns 大于等于 min 的合法数值
 */
export function parseFailFastMinimumNumberConfig({
  env,
  envKey,
  defaultValue,
  min,
}: MinimumNumberConfig): number {
  const raw = env[envKey];
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    throw createConfigValidationError(`[配置错误] ${envKey} 无效（必须为数字且 >= ${min}）`, [
      envKey,
    ]);
  }

  return value;
}

/**
 * 读取百分比值配置并保持运行时口径不变。
 * @param env 进程环境变量对象
 * @param envKey 环境变量键名
 * @param minValue 允许的最小原始数值
 * @returns 百分比值或 null
 */
function getPercentValueConfig(
  env: NodeJS.ProcessEnv,
  envKey: string,
  minValue: number = 0,
): number | null {
  return getNumberConfig(env, envKey, minValue);
}

/**
 * 将 OpenAPI 订单类型映射为内部订单类型配置。
 * @param orderType OpenAPI 订单类型
 * @returns 内部订单类型配置
 */
function mapOrderTypeConfig(orderType: OrderType): OrderTypeConfig {
  return OPEN_API_ORDER_TYPE_TO_CONFIG[orderType] ?? 'ELO';
}

/**
 * 解析单个监控标的配置。
 * @param env 进程环境变量对象
 * @param index 监控标的索引
 * @returns 解析后的监控配置，该索引未配置时返回 null
 */
export function parseMonitorConfig(env: NodeJS.ProcessEnv, index: number): MonitorConfig | null {
  if (index < 1) {
    return null;
  }

  const suffix = `_${index}`;
  const monitorSymbol = getStringConfig(env, `MONITOR_SYMBOL${suffix}`);
  if (!monitorSymbol) {
    return null;
  }

  const longSymbol = getStringConfig(env, `LONG_SYMBOL${suffix}`) ?? '';
  const shortSymbol = getStringConfig(env, `SHORT_SYMBOL${suffix}`) ?? '';
  const autoSearchEnabled = getBooleanConfig(env, `AUTO_SEARCH_ENABLED${suffix}`, false);
  const autoSearchMinDistancePctBull = getPercentValueConfig(
    env,
    `AUTO_SEARCH_MIN_DISTANCE_PCT_BULL${suffix}`,
    0,
  );
  const autoSearchMinDistancePctBear = getPercentValueConfig(
    env,
    `AUTO_SEARCH_MIN_DISTANCE_PCT_BEAR${suffix}`,
    -100,
  );
  const autoSearchMinTurnoverPerMinuteBull = getNumberConfig(
    env,
    `AUTO_SEARCH_MIN_TURNOVER_PER_MINUTE_BULL${suffix}`,
    0,
  );
  const autoSearchMinTurnoverPerMinuteBear = getNumberConfig(
    env,
    `AUTO_SEARCH_MIN_TURNOVER_PER_MINUTE_BEAR${suffix}`,
    0,
  );
  const autoSearchExpiryMinMonths = parseBoundedNumberConfig({
    env,
    envKey: `AUTO_SEARCH_EXPIRY_MIN_MONTHS${suffix}`,
    defaultValue: 3,
    min: 1,
    max: 120,
  });
  const autoSearchOpenDelayMinutes = parseBoundedNumberConfig({
    env,
    envKey: `AUTO_SEARCH_OPEN_DELAY_MINUTES${suffix}`,
    defaultValue: 5,
    min: 0,
    max: 60,
  });
  const switchIntervalMinutes = autoSearchEnabled
    ? parseFailFastBoundedNumberConfig({
        env,
        envKey: `SWITCH_INTERVAL_MINUTES${suffix}`,
        defaultValue: 0,
        min: 0,
        max: 120,
      })
    : 0;
  const switchDistanceRangeBull = parseNumberRangeConfig(
    env,
    `SWITCH_DISTANCE_RANGE_BULL${suffix}`,
  );
  const switchDistanceRangeBear = parseNumberRangeConfig(
    env,
    `SWITCH_DISTANCE_RANGE_BEAR${suffix}`,
  );
  const orderOwnershipMapping = parseOrderOwnershipMapping(env, `ORDER_OWNERSHIP_MAPPING${suffix}`);
  const targetNotional = parseFailFastMinimumNumberConfig({
    env,
    envKey: `TARGET_NOTIONAL${suffix}`,
    defaultValue: 10000,
    min: 1,
  });
  const maxPositionNotional = parseFailFastMinimumNumberConfig({
    env,
    envKey: `MAX_POSITION_NOTIONAL${suffix}`,
    defaultValue: 100000,
    min: 1,
  });
  const maxUnrealizedLossPerSymbol =
    getNumberConfig(env, `MAX_UNREALIZED_LOSS_PER_SYMBOL${suffix}`, 0) ?? 0;
  const buyIntervalSeconds = parseFailFastBoundedNumberConfig({
    env,
    envKey: `BUY_INTERVAL_SECONDS${suffix}`,
    defaultValue: 60,
    min: 10,
    max: 600,
  });
  const liquidationCooldown = parseLiquidationCooldownConfig(
    env,
    `LIQUIDATION_COOLDOWN_MINUTES${suffix}`,
  );
  const liquidationTriggerLimit = parseBoundedNumberConfig({
    env,
    envKey: `LIQUIDATION_TRIGGER_LIMIT${suffix}`,
    defaultValue: 1,
    min: 1,
    max: 10,
  });
  const verificationConfig = {
    buy: {
      delaySeconds: parseVerificationDelay(env, `VERIFICATION_DELAY_SECONDS_BUY${suffix}`, 60),
      indicators: parseVerificationIndicators(env, `VERIFICATION_INDICATORS_BUY${suffix}`),
    },
    sell: {
      delaySeconds: parseVerificationDelay(env, `VERIFICATION_DELAY_SECONDS_SELL${suffix}`, 60),
      indicators: parseVerificationIndicators(env, `VERIFICATION_INDICATORS_SELL${suffix}`),
    },
  };
  const smartCloseEnabled = getBooleanConfig(env, `SMART_CLOSE_ENABLED${suffix}`, true);
  const smartCloseTimeoutMinutes = parseSmartCloseTimeoutMinutesConfig(
    env,
    `SMART_CLOSE_TIMEOUT_MINUTES${suffix}`,
  );
  const signalConfig = {
    buycall: parseSignalConfigFromEnv(env, `SIGNAL_BUYCALL${suffix}`),
    sellcall: parseSignalConfigFromEnv(env, `SIGNAL_SELLCALL${suffix}`),
    buyput: parseSignalConfigFromEnv(env, `SIGNAL_BUYPUT${suffix}`),
    sellput: parseSignalConfigFromEnv(env, `SIGNAL_SELLPUT${suffix}`),
  };

  return {
    originalIndex: index,
    monitorSymbol,
    longSymbol,
    shortSymbol,
    autoSearchConfig: {
      autoSearchEnabled,
      autoSearchMinDistancePctBull,
      autoSearchMinDistancePctBear,
      autoSearchMinTurnoverPerMinuteBull,
      autoSearchMinTurnoverPerMinuteBear,
      autoSearchExpiryMinMonths,
      autoSearchOpenDelayMinutes,
      switchIntervalMinutes,
      switchDistanceRangeBull,
      switchDistanceRangeBear,
    },
    orderOwnershipMapping,
    targetNotional,
    maxPositionNotional,
    maxUnrealizedLossPerSymbol,
    buyIntervalSeconds,
    liquidationCooldown,
    liquidationTriggerLimit,
    verificationConfig,
    signalConfig,
    smartCloseEnabled,
    smartCloseTimeoutMinutes,
  };
}

/**
 * 解析交易订单类型配置。
 * @param env 进程环境变量对象
 * @param envKey 环境变量键名
 * @param defaultType 默认订单类型
 * @returns 内部订单类型配置
 */
export function parseTradingOrderType(
  env: NodeJS.ProcessEnv,
  envKey: string,
  defaultType: OrderTypeConfig,
): OrderTypeConfig {
  return mapOrderTypeConfig(parseOrderTypeConfig(env, envKey, defaultType));
}

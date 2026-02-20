/**
 * 交易配置模块
 *
 * 从环境变量读取交易相关配置，支持多标的配置（通过 _N 后缀区分）
 * 配置包括：标的代码、交易金额、风险限制、信号规则、延迟验证等
 */
import { OrderType } from 'longport';
import type { MonitorConfig, MultiMonitorTradingConfig } from '../types/config.js';
import type { OrderTypeConfig } from '../types/signal.js';
import type { SignalConfig } from '../types/signalConfig.js';
import { parseSignalConfig } from '../utils/helpers/signalConfigParser.js';
import { logger } from '../utils/logger/index.js';
import { TRADING } from '../constants/index.js';
import {
  getBooleanConfig,
  getNumberConfig,
  getStringConfig,
  parseLiquidationCooldownConfig,
  parseNumberRangeConfig,
  parseOrderOwnershipMapping,
  parseOrderTypeConfig,
  parseVerificationDelay,
  parseVerificationIndicators,
} from './utils.js';
import type { BoundedNumberConfig } from './types.js';

/**
 * 从环境变量解析信号配置字符串，未配置或解析失败时返回 null。
 * @param env - 进程环境变量对象
 * @param envKey - 环境变量键名（如 SIGNAL_BUYCALL_1）
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
 * 解析带上下限的数值配置，超出范围时截断至边界值并输出警告。
 * 用于需要强制约束范围的配置项（如超时秒数、间隔时间等）。
 * @param options - 包含 env、envKey、defaultValue、min、max 的配置对象
 * @returns 解析后的数值（未配置时返回 defaultValue，超出范围时截断为 min/max）
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
 * 读取百分比配置并转为小数（如配置 2 → 内部 0.02），未配置或无效时返回 null。
 * 用于需要以百分比形式配置、但内部以小数运算的字段（如距离回收价百分比）。
 * @param env - 进程环境变量对象
 * @param envKey - 环境变量键名
 * @param minValue - 允许的最小原始数值，默认为 0
 * @returns 除以 100 后的小数，或 null
 */
function getPercentAsDecimalConfig(
  env: NodeJS.ProcessEnv,
  envKey: string,
  minValue: number = 0,
): number | null {
  const raw = getNumberConfig(env, envKey, minValue);
  return raw == null ? null : raw / 100;
}

/**
 * 将 OpenAPI 订单类型枚举映射为配置值字符串，用于统一内部订单类型表示。
 * @param orderType - LongPort OrderType 枚举值
 * @returns 对应的订单类型配置字符串（'LO' | 'MO' | 'ELO'）
 */
function mapOrderTypeConfig(orderType: OrderType): OrderTypeConfig {
  switch (orderType) {
    case OrderType.LO:
      return 'LO';
    case OrderType.MO:
      return 'MO';
    default:
      return 'ELO';
  }
}

/**
 * 解析单个监控标的配置（索引 >= 1），连续扫描时遇到未配置的 MONITOR_SYMBOL 即表示该索引无配置。
 * @param env - 进程环境变量对象
 * @param index - 监控标的索引（从 1 开始，对应环境变量后缀 _1、_2 等）
 * @returns 解析后的监控配置，该索引未配置或配置不完整时返回 null
 */
function parseMonitorConfig(env: NodeJS.ProcessEnv, index: number): MonitorConfig | null {
  if (index < 1) {
    return null;
  }
  const suffix = `_${index}`;

  const monitorSymbol = getStringConfig(env, `MONITOR_SYMBOL${suffix}`);
  if (!monitorSymbol) {
    return null; // 该索引无配置
  }

  const longSymbol = getStringConfig(env, `LONG_SYMBOL${suffix}`) || '';
  const shortSymbol = getStringConfig(env, `SHORT_SYMBOL${suffix}`) || '';

  const autoSearchEnabled = getBooleanConfig(env, `AUTO_SEARCH_ENABLED${suffix}`, false);
  // 百分比数值转为小数：配置值 2 → 内部 0.02（牛证 >= 0，熊证 <= 0）
  const autoSearchMinDistancePctBull = getPercentAsDecimalConfig(
    env,
    `AUTO_SEARCH_MIN_DISTANCE_PCT_BULL${suffix}`,
    0,
  );
  const autoSearchMinDistancePctBear = getPercentAsDecimalConfig(
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
  const switchDistanceRangeBull = parseNumberRangeConfig(
    env,
    `SWITCH_DISTANCE_RANGE_BULL${suffix}`,
  );
  const switchDistanceRangeBear = parseNumberRangeConfig(
    env,
    `SWITCH_DISTANCE_RANGE_BEAR${suffix}`,
  );
  const orderOwnershipMapping = parseOrderOwnershipMapping(env, `ORDER_OWNERSHIP_MAPPING${suffix}`);

  // 使用 ?? 保留 0 的合法配置，仅在 null/undefined 时回退默认值
  const targetNotional = getNumberConfig(env, `TARGET_NOTIONAL${suffix}`, 1) ?? 10000;
  const maxPositionNotional = getNumberConfig(env, `MAX_POSITION_NOTIONAL${suffix}`, 1) ?? 100000;
  const maxDailyLoss = getNumberConfig(env, `MAX_DAILY_LOSS${suffix}`, 0) ?? 0;
  const maxUnrealizedLossPerSymbol =
    getNumberConfig(env, `MAX_UNREALIZED_LOSS_PER_SYMBOL${suffix}`, 0) ?? 0;

  const buyIntervalSeconds = parseBoundedNumberConfig({
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

  // 智能平仓策略开关，默认启用
  const smartCloseEnabled = getBooleanConfig(env, `SMART_CLOSE_ENABLED${suffix}`, true);

  const signalConfig = {
    buycall: parseSignalConfigFromEnv(env, `SIGNAL_BUYCALL${suffix}`),
    sellcall: parseSignalConfigFromEnv(env, `SIGNAL_SELLCALL${suffix}`),
    buyput: parseSignalConfigFromEnv(env, `SIGNAL_BUYPUT${suffix}`),
    sellput: parseSignalConfigFromEnv(env, `SIGNAL_SELLPUT${suffix}`),
  };

  return {
    originalIndex: index, // 保存原始索引，用于错误提示
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
      switchDistanceRangeBull,
      switchDistanceRangeBear,
    },
    orderOwnershipMapping,
    targetNotional,
    maxPositionNotional,
    maxDailyLoss,
    maxUnrealizedLossPerSymbol,
    buyIntervalSeconds,
    liquidationCooldown,
    verificationConfig,
    signalConfig,
    smartCloseEnabled,
  };
}

/**
 * 解析所有监控标的配置，自动从 MONITOR_SYMBOL_1 起连续扫描，遇第一个未配置索引即停止。
 * 同时解析全局配置（开盘保护、订单超时、订单类型等）。
 * @param env - 进程环境变量对象
 * @returns 多监控标的交易配置（monitors 数组 + global 全局配置）
 */
export function createMultiMonitorTradingConfig({
  env,
}: {
  env: NodeJS.ProcessEnv;
}): MultiMonitorTradingConfig {
  const monitors: MonitorConfig[] = [];

  // 连续扫描监控标的配置：从 _1 开始，遇到第一个未配置的索引即停止
  // 注意：索引必须连续，如配置了 _1 和 _3 但跳过 _2，则 _3 不会被读取
  for (let i = 1; i <= TRADING.MAX_MONITOR_SCAN_RANGE; i++) {
    const monitorSymbol = getStringConfig(env, `MONITOR_SYMBOL_${i}`);
    if (!monitorSymbol) {
      // 未找到 MONITOR_SYMBOL_N，停止扫描
      break;
    }

    const config = parseMonitorConfig(env, i);
    if (config) {
      monitors.push(config);
    } else {
      logger.warn(`[配置警告] 监控标的 ${i} 配置不完整，已跳过`);
    }
  }

  // 解析买入订单超时配置
  const buyOrderTimeoutEnabled = getBooleanConfig(env, 'BUY_ORDER_TIMEOUT_ENABLED', true);
  const buyOrderTimeoutSeconds = parseBoundedNumberConfig({
    env,
    envKey: 'BUY_ORDER_TIMEOUT_SECONDS',
    defaultValue: 180,
    min: 30,
    max: 600,
  });

  // 解析卖出订单超时配置
  const sellOrderTimeoutEnabled = getBooleanConfig(env, 'SELL_ORDER_TIMEOUT_ENABLED', true);
  const sellOrderTimeoutSeconds = parseBoundedNumberConfig({
    env,
    envKey: 'SELL_ORDER_TIMEOUT_SECONDS',
    defaultValue: 180,
    min: 30,
    max: 600,
  });

  // 解析订单监控价格更新间隔配置
  const orderMonitorPriceUpdateInterval = parseBoundedNumberConfig({
    env,
    envKey: 'ORDER_MONITOR_PRICE_UPDATE_INTERVAL',
    defaultValue: 5,
    min: 1,
    max: 60,
  });

  // 早盘开盘保护
  const morningOpenProtectionEnabled = getBooleanConfig(
    env,
    'MORNING_OPENING_PROTECTION_ENABLED',
    false,
  );
  const morningOpenProtectionMinutes = getNumberConfig(
    env,
    'MORNING_OPENING_PROTECTION_MINUTES',
    0,
  );

  // 午盘开盘保护
  const afternoonOpenProtectionEnabled = getBooleanConfig(
    env,
    'AFTERNOON_OPENING_PROTECTION_ENABLED',
    false,
  );
  const afternoonOpenProtectionMinutes = getNumberConfig(
    env,
    'AFTERNOON_OPENING_PROTECTION_MINUTES',
    0,
  );

  // 解析交易订单类型配置
  const tradingOrderType = mapOrderTypeConfig(
    parseOrderTypeConfig(env, 'TRADING_ORDER_TYPE', 'ELO'),
  );

  // 解析清仓订单类型配置
  const liquidationOrderType = mapOrderTypeConfig(
    parseOrderTypeConfig(env, 'LIQUIDATION_ORDER_TYPE', 'MO'),
  );

  return {
    monitors,
    global: {
      doomsdayProtection: getBooleanConfig(env, 'DOOMSDAY_PROTECTION', true),
      debug: getBooleanConfig(env, 'DEBUG', false),
      openProtection: {
        morning: {
          enabled: morningOpenProtectionEnabled,
          minutes: morningOpenProtectionMinutes,
        },
        afternoon: {
          enabled: afternoonOpenProtectionEnabled,
          minutes: afternoonOpenProtectionMinutes,
        },
      },
      orderMonitorPriceUpdateInterval,
      tradingOrderType,
      liquidationOrderType,
      buyOrderTimeout: {
        enabled: buyOrderTimeoutEnabled,
        timeoutSeconds: buyOrderTimeoutSeconds,
      },
      sellOrderTimeout: {
        enabled: sellOrderTimeoutEnabled,
        timeoutSeconds: sellOrderTimeoutSeconds,
      },
    },
  };
}

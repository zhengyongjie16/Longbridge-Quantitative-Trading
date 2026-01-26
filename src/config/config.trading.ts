/**
 * 交易配置模块
 *
 * 从环境变量读取交易相关配置，支持多标的配置（通过 _N 后缀区分）
 * 配置包括：标的代码、交易金额、风险限制、信号规则、延迟验证等
 */

import { OrderType } from 'longport';
import type {
  MonitorConfig,
  MultiMonitorTradingConfig,
  OrderTypeConfig,
  SignalConfig,
} from '../types/index.js';
import { parseSignalConfig } from '../utils/helpers/signalConfigParser.js';
import { logger } from '../utils/logger/index.js';
import {
  getBooleanConfig,
  getNumberConfig,
  getStringConfig,
  parseLiquidationCooldownConfig,
  parseOrderTypeConfig,
  parseVerificationDelay,
  parseVerificationIndicators,
} from './utils.js';

/** 从环境变量解析信号配置 */
function parseSignalConfigFromEnv(
  env: NodeJS.ProcessEnv,
  envKey: string,
): SignalConfig | null {
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

type BoundedNumberConfig = {
  readonly env: NodeJS.ProcessEnv;
  readonly envKey: string;
  readonly defaultValue: number;
  readonly min: number;
  readonly max: number;
};

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

function mapOrderTypeConfig(orderType: OrderType): OrderTypeConfig {
  if (orderType === OrderType.LO) {
    return 'LO';
  }
  if (orderType === OrderType.MO) {
    return 'MO';
  }
  return 'ELO';
}

/** 解析单个监控标的配置（索引 >= 1），未找到返回 null */
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

/** 监控标的最大扫描范围（从 _1 扫描到 _100） */
const MAX_MONITOR_SCAN_RANGE = 100;

/** 解析所有监控标的配置，自动扫描 MONITOR_SYMBOL_1, _2, ... */
export function createMultiMonitorTradingConfig({
  env,
}: {
  env: NodeJS.ProcessEnv;
}): MultiMonitorTradingConfig {
  const monitors: MonitorConfig[] = [];

  // 连续扫描监控标的配置：从 _1 开始，遇到第一个未配置的索引即停止
  // 注意：索引必须连续，如配置了 _1 和 _3 但跳过 _2，则 _3 不会被读取
  for (let i = 1; i <= MAX_MONITOR_SCAN_RANGE; i++) {
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

  // 开盘波动较大，指标可靠性下降，可在早盘启用保护避免误触发
  const openProtectionEnabled = getBooleanConfig(env, 'OPENING_PROTECTION_ENABLED', false);
  const openProtectionMinutes = getNumberConfig(env, 'OPENING_PROTECTION_MINUTES', 0);

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
        enabled: openProtectionEnabled,
        minutes: openProtectionMinutes,
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


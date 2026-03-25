/**
 * trading 配置模块。
 *
 * 负责扫描多监控标的配置，解析 monitor/global 两级交易配置，
 * 并保持原有 fail-fast 行为与默认值语义不变。
 */
import type { MonitorConfig, MultiMonitorTradingConfig } from '../../types/config.js';
import { TRADING } from '../../constants/index.js';
import {
  createConfigValidationError,
  getBooleanConfig,
  getNumberConfig,
  getStringConfig,
} from '../utils.js';
import {
  parseFailFastBoundedNumberConfig,
  parseMonitorConfig,
  parseTradingOrderType,
} from './utils.js';

/**
 * 解析所有监控标的配置，自动扫描 MONITOR_SYMBOL_1..N 并强制索引连续。
 * @param params.env 进程环境变量对象
 * @returns 多监控标的交易配置
 */
export function createMultiMonitorTradingConfig({
  env,
}: {
  env: NodeJS.ProcessEnv;
}): MultiMonitorTradingConfig {
  const monitors: MonitorConfig[] = [];
  const configuredMonitorIndexes: number[] = [];

  for (let i = 1; i <= TRADING.MAX_MONITOR_SCAN_RANGE; i++) {
    const monitorSymbol = getStringConfig(env, `MONITOR_SYMBOL_${i}`);
    if (!monitorSymbol) {
      continue;
    }

    configuredMonitorIndexes.push(i);
  }

  if (configuredMonitorIndexes.length > 0) {
    const configuredMonitorSet = new Set(configuredMonitorIndexes);
    const highestConfiguredIndex = configuredMonitorIndexes.at(-1) ?? 0;
    for (let i = 1; i <= highestConfiguredIndex; i++) {
      if (!configuredMonitorSet.has(i)) {
        throw createConfigValidationError(
          `[配置错误] MONITOR_SYMBOL_${i} 未配置（监控标的索引必须连续，不允许断档）`,
          [`MONITOR_SYMBOL_${i}`],
        );
      }
    }

    for (let i = 1; i <= highestConfiguredIndex; i++) {
      const config = parseMonitorConfig(env, i);
      if (!config) {
        throw createConfigValidationError(
          `[配置错误] MONITOR_SYMBOL_${i} 未配置（监控标的索引必须连续）`,
          [`MONITOR_SYMBOL_${i}`],
        );
      }

      monitors.push(config);
    }
  }

  const buyOrderTimeoutEnabled = getBooleanConfig(env, 'BUY_ORDER_TIMEOUT_ENABLED', true);
  const buyOrderTimeoutSeconds = buyOrderTimeoutEnabled
    ? parseFailFastBoundedNumberConfig({
        env,
        envKey: 'BUY_ORDER_TIMEOUT_SECONDS',
        defaultValue: 180,
        min: 30,
        max: 600,
      })
    : 180;
  const sellOrderTimeoutEnabled = getBooleanConfig(env, 'SELL_ORDER_TIMEOUT_ENABLED', true);
  const sellOrderTimeoutSeconds = sellOrderTimeoutEnabled
    ? parseFailFastBoundedNumberConfig({
        env,
        envKey: 'SELL_ORDER_TIMEOUT_SECONDS',
        defaultValue: 180,
        min: 30,
        max: 600,
      })
    : 180;
  const orderMonitorPriceUpdateInterval = parseFailFastBoundedNumberConfig({
    env,
    envKey: 'ORDER_MONITOR_PRICE_UPDATE_INTERVAL',
    defaultValue: 5,
    min: 1,
    max: 60,
  });
  const allowBuyOrderTrackingAboveInitialPrice = getBooleanConfig(
    env,
    'ALLOW_BUY_ORDER_TRACKING_ABOVE_INITIAL_PRICE',
    true,
  );
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
  const tradingOrderType = parseTradingOrderType(env, 'TRADING_ORDER_TYPE', 'ELO');
  const liquidationOrderType = parseTradingOrderType(env, 'LIQUIDATION_ORDER_TYPE', 'MO');

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
      allowBuyOrderTrackingAboveInitialPrice,
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

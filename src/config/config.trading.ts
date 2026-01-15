/**
 * 交易配置模块
 *
 * 功能：
 * - 从环境变量读取所有交易相关配置
 * - 统一管理标的代码、交易金额、风险限制等配置
 * - 提供配置验证和默认值处理
 *
 * 配置类别：
 * 1. 标的配置：MONITOR_SYMBOL（监控标的）、LONG_SYMBOL（做多标的）、SHORT_SYMBOL（做空标的）
 * 2. 交易金额：TARGET_NOTIONAL（目标金额）
 * 3. 风险限制：MAX_POSITION_NOTIONAL（最大持仓）、MAX_DAILY_LOSS（单日亏损限制）
 * 4. 信号配置：SIGNAL_BUYCALL、SIGNAL_SELLCALL、SIGNAL_BUYPUT、SIGNAL_SELLPUT
 * 5. 验证配置：
 *    - 买入验证：VERIFICATION_DELAY_SECONDS_BUY（延迟验证时间）、VERIFICATION_INDICATORS_BUY（验证指标）
 *    - 卖出验证：VERIFICATION_DELAY_SECONDS_SELL（延迟验证时间）、VERIFICATION_INDICATORS_SELL（验证指标）
 *
 * 注意：每手股数（lotSize）将通过 LongPort API 自动获取，无需手动配置
 */

import dotenv from 'dotenv';
dotenv.config();

import { parseSignalConfig } from '../utils/helpers/signalConfigParser.js';
import { validateEmaPeriod } from '../utils/helpers/indicatorHelpers.js';
import { normalizeHKSymbol } from '../utils/helpers/index.js';
import { logger } from '../utils/logger/index.js';
import type {
  MonitorConfig,
  MultiMonitorTradingConfig,
} from '../types/index.js';

/**
 * 从环境变量读取字符串配置
 * @param envKey 环境变量键名
 * @returns 配置值，如果未设置则返回 null
 */
function getStringConfig(envKey: string): string | null {
  const value = process.env[envKey];
  if (
    !value ||
    value.trim() === '' ||
    value === `your_${envKey.toLowerCase()}_here`
  ) {
    return null;
  }
  return value.trim();
}

/**
 * 从环境变量读取数字配置
 * @param envKey 环境变量键名
 * @param minValue 最小值（可选）
 * @returns 配置值，如果未设置或无效则返回 null
 */
function getNumberConfig(envKey: string, minValue: number = 0): number | null {
  const value = process.env[envKey];
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
 * 从环境变量读取布尔配置
 * @param envKey 环境变量键名
 * @param defaultValue 默认值（当环境变量未设置时使用）
 * @returns 配置值
 */
function getBooleanConfig(envKey: string, defaultValue: boolean = false): boolean {
  const value = process.env[envKey];
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
}

/**
 * 解析验证延迟时间配置
 * @param envKey 环境变量键名
 * @param defaultValue 默认值
 * @returns 延迟时间（秒），范围 0-120
 */
function parseVerificationDelay(envKey: string, defaultValue: number): number {
  const delay = getNumberConfig(envKey, 0);
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

/**
 * 解析验证指标配置
 * @param envKey 环境变量键名
 * @returns 指标列表，如果未设置或无效则返回 null
 */
function parseVerificationIndicators(envKey: string): ReadonlyArray<string> | null {
  const value = process.env[envKey];
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
}

/**
 * 解析单个监控标的的配置（从带索引的环境变量）
 * @param index 监控标的索引（必须 >= 1）
 * @returns 监控标的配置，如果未找到则返回 null
 */
function parseMonitorConfig(index: number): MonitorConfig | null {
  if (index < 1) {
    return null;
  }
  const suffix = `_${index}`;

  const monitorSymbol = getStringConfig(`MONITOR_SYMBOL${suffix}`);
  if (!monitorSymbol) {
    return null; // 该索引无配置
  }

  const longSymbol = getStringConfig(`LONG_SYMBOL${suffix}`) || '';
  const shortSymbol = getStringConfig(`SHORT_SYMBOL${suffix}`) || '';

  const targetNotional = getNumberConfig(`TARGET_NOTIONAL${suffix}`, 1) ?? 10000;
  const maxPositionNotional = getNumberConfig(`MAX_POSITION_NOTIONAL${suffix}`, 1) ?? 100000;
  const maxDailyLoss = getNumberConfig(`MAX_DAILY_LOSS${suffix}`, 0) ?? 0;
  const maxUnrealizedLossPerSymbol =
    getNumberConfig(`MAX_UNREALIZED_LOSS_PER_SYMBOL${suffix}`, 0) ?? 0;

  const buyIntervalSeconds = (() => {
    const interval = getNumberConfig(`BUY_INTERVAL_SECONDS${suffix}`, 0);
    if (interval === null) {
      return 60;
    }
    if (interval < 10) {
      logger.warn(
        `[配置警告] BUY_INTERVAL_SECONDS${suffix} 不能小于 10，已设置为 10`,
      );
      return 10;
    }
    if (interval > 600) {
      logger.warn(
        `[配置警告] BUY_INTERVAL_SECONDS${suffix} 不能大于 600，已设置为 600`,
      );
      return 600;
    }
    return interval;
  })();

  const verificationConfig = {
    buy: {
      delaySeconds: parseVerificationDelay(`VERIFICATION_DELAY_SECONDS_BUY${suffix}`, 60),
      indicators: parseVerificationIndicators(`VERIFICATION_INDICATORS_BUY${suffix}`),
    },
    sell: {
      delaySeconds: parseVerificationDelay(`VERIFICATION_DELAY_SECONDS_SELL${suffix}`, 60),
      indicators: parseVerificationIndicators(`VERIFICATION_INDICATORS_SELL${suffix}`),
    },
  };

  // 智能平仓策略开关，默认启用
  const smartCloseEnabled = getBooleanConfig(`SMART_CLOSE_ENABLED${suffix}`, true);

  const signalConfig = {
    buycall: (() => {
      const configStr = getStringConfig(`SIGNAL_BUYCALL${suffix}`);
      if (!configStr) {
        return null;
      }
      const config = parseSignalConfig(configStr);
      if (!config) {
        logger.error(`[配置错误] SIGNAL_BUYCALL${suffix} 格式无效`);
        return null;
      }
      return config;
    })(),
    sellcall: (() => {
      const configStr = getStringConfig(`SIGNAL_SELLCALL${suffix}`);
      if (!configStr) {
        return null;
      }
      const config = parseSignalConfig(configStr);
      if (!config) {
        logger.error(`[配置错误] SIGNAL_SELLCALL${suffix} 格式无效`);
        return null;
      }
      return config;
    })(),
    buyput: (() => {
      const configStr = getStringConfig(`SIGNAL_BUYPUT${suffix}`);
      if (!configStr) {
        return null;
      }
      const config = parseSignalConfig(configStr);
      if (!config) {
        logger.error(`[配置错误] SIGNAL_BUYPUT${suffix} 格式无效`);
        return null;
      }
      return config;
    })(),
    sellput: (() => {
      const configStr = getStringConfig(`SIGNAL_SELLPUT${suffix}`);
      if (!configStr) {
        return null;
      }
      const config = parseSignalConfig(configStr);
      if (!config) {
        logger.error(`[配置错误] SIGNAL_SELLPUT${suffix} 格式无效`);
        return null;
      }
      return config;
    })(),
  };

  return {
    monitorSymbol: normalizeHKSymbol(monitorSymbol),
    longSymbol: normalizeHKSymbol(longSymbol),
    shortSymbol: normalizeHKSymbol(shortSymbol),
    targetNotional,
    maxPositionNotional,
    maxDailyLoss,
    maxUnrealizedLossPerSymbol,
    buyIntervalSeconds,
    verificationConfig,
    signalConfig,
    smartCloseEnabled,
  };
}

/**
 * 解析所有监控标的配置
 */
export const MULTI_MONITOR_TRADING_CONFIG: MultiMonitorTradingConfig = (() => {
  const monitors: MonitorConfig[] = [];

  const monitorCount = getNumberConfig('MONITOR_COUNT', 1);
  if (!monitorCount || monitorCount < 1) {
    logger.error('[配置错误] MONITOR_COUNT 未配置或无效，必须 >= 1');
    return {
      monitors: [],
      global: {
        doomsdayProtection: getBooleanConfig('DOOMSDAY_PROTECTION', true),
        debug: getBooleanConfig('DEBUG', false),
        orderMonitorTimeoutSeconds: 180,
        orderMonitorPriceUpdateInterval: 5,
      },
    };
  }

  for (let i = 1; i <= monitorCount; i++) {
    const config = parseMonitorConfig(i);
    if (config) {
      monitors.push(config);
    } else {
      logger.warn(`[配置警告] 监控标的 ${i} 配置不完整，已跳过`);
    }
  }

  // 解析订单监控超时配置
  const orderMonitorTimeoutSeconds = (() => {
    const timeout = getNumberConfig('ORDER_MONITOR_TIMEOUT_SECONDS', 0);
    if (timeout === null) {
      return 180; // 默认 3 分钟
    }
    if (timeout < 30) {
      logger.warn('[配置警告] ORDER_MONITOR_TIMEOUT_SECONDS 不能小于 30，已设置为 30');
      return 30;
    }
    if (timeout > 600) {
      logger.warn('[配置警告] ORDER_MONITOR_TIMEOUT_SECONDS 不能大于 600，已设置为 600');
      return 600;
    }
    return timeout;
  })();

  // 解析订单监控价格更新间隔配置
  const orderMonitorPriceUpdateInterval = (() => {
    const interval = getNumberConfig('ORDER_MONITOR_PRICE_UPDATE_INTERVAL', 0);
    if (interval === null) {
      return 5; // 默认 5 秒
    }
    if (interval < 1) {
      logger.warn('[配置警告] ORDER_MONITOR_PRICE_UPDATE_INTERVAL 不能小于 1，已设置为 1');
      return 1;
    }
    if (interval > 60) {
      logger.warn('[配置警告] ORDER_MONITOR_PRICE_UPDATE_INTERVAL 不能大于 60，已设置为 60');
      return 60;
    }
    return interval;
  })();

  return {
    monitors,
    global: {
      doomsdayProtection: getBooleanConfig('DOOMSDAY_PROTECTION', true),
      debug: getBooleanConfig('DEBUG', false),
      orderMonitorTimeoutSeconds,
      orderMonitorPriceUpdateInterval,
    },
  };
})();


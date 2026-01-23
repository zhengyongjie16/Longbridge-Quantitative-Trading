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

import { parseSignalConfig } from '../utils/helpers/signalConfigParser.js';
import { normalizeHKSymbol } from '../utils/helpers/index.js';
import { logger } from '../utils/logger/index.js';
import { OrderType } from 'longport';
import {
  getBooleanConfig,
  getNumberConfig,
  getStringConfig,
  parseOrderTypeConfig,
  parseVerificationDelay,
  parseVerificationIndicators,
} from './utils.js';
import type {
  MonitorConfig,
  MultiMonitorTradingConfig,
} from '../types/index.js';

/**
 * 解析信号配置（内部复用逻辑）
 */
const parseSignalConfigFromEnv = (
  env: NodeJS.ProcessEnv,
  envKey: string,
): ReturnType<typeof parseSignalConfig> | null => {
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
};

/**
 * 解析单个监控标的的配置（从带索引的环境变量）
 * @param index 监控标的索引（必须 >= 1）
 * @returns 监控标的配置，如果未找到则返回 null
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

  const targetNotional = getNumberConfig(env, `TARGET_NOTIONAL${suffix}`, 1) ?? 10000;
  const maxPositionNotional = getNumberConfig(env, `MAX_POSITION_NOTIONAL${suffix}`, 1) ?? 100000;
  const maxDailyLoss = getNumberConfig(env, `MAX_DAILY_LOSS${suffix}`, 0) ?? 0;
  const maxUnrealizedLossPerSymbol =
    getNumberConfig(env, `MAX_UNREALIZED_LOSS_PER_SYMBOL${suffix}`, 0) ?? 0;

  const buyIntervalSeconds = (() => {
    const interval = getNumberConfig(env, `BUY_INTERVAL_SECONDS${suffix}`, 0);
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
 * 自动检测监控标的数量的最大扫描范围
 * 从 _1 开始扫描，直到连续找不到配置为止
 */
const MAX_MONITOR_SCAN_RANGE = 100;

/**
 * 解析所有监控标的配置
 * 自动检测环境变量中存在的监控标的配置（MONITOR_SYMBOL_1, MONITOR_SYMBOL_2, ...）
 */
export const createMultiMonitorTradingConfig = ({
  env,
}: {
  env: NodeJS.ProcessEnv;
}): MultiMonitorTradingConfig => {
  const monitors: MonitorConfig[] = [];

  // 自动扫描监控标的配置，从 _1 开始，直到找不到 MONITOR_SYMBOL_N 为止
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
  const buyOrderTimeoutSeconds = (() => {
    const timeout = getNumberConfig(env, 'BUY_ORDER_TIMEOUT_SECONDS', 0);
    if (timeout === null) {
      return 180; // 默认 3 分钟
    }
    if (timeout < 30) {
      logger.warn('[配置警告] BUY_ORDER_TIMEOUT_SECONDS 不能小于 30，已设置为 30');
      return 30;
    }
    if (timeout > 600) {
      logger.warn('[配置警告] BUY_ORDER_TIMEOUT_SECONDS 不能大于 600，已设置为 600');
      return 600;
    }
    return timeout;
  })();

  // 解析卖出订单超时配置
  const sellOrderTimeoutEnabled = getBooleanConfig(env, 'SELL_ORDER_TIMEOUT_ENABLED', true);
  const sellOrderTimeoutSeconds = (() => {
    const timeout = getNumberConfig(env, 'SELL_ORDER_TIMEOUT_SECONDS', 0);
    if (timeout === null) {
      return 180; // 默认 3 分钟
    }
    if (timeout < 30) {
      logger.warn('[配置警告] SELL_ORDER_TIMEOUT_SECONDS 不能小于 30，已设置为 30');
      return 30;
    }
    if (timeout > 600) {
      logger.warn('[配置警告] SELL_ORDER_TIMEOUT_SECONDS 不能大于 600，已设置为 600');
      return 600;
    }
    return timeout;
  })();

  // 解析订单监控价格更新间隔配置
  const orderMonitorPriceUpdateInterval = (() => {
    const interval = getNumberConfig(env, 'ORDER_MONITOR_PRICE_UPDATE_INTERVAL', 0);
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

  // 解析交易订单类型配置
  const tradingOrderType = (() => {
    const orderType = parseOrderTypeConfig(env, 'TRADING_ORDER_TYPE', 'ELO');
    // 将 OrderType 枚举值转换回字符串以符合 GlobalConfig 类型
    if (orderType === OrderType.LO) return 'LO' as const;
    if (orderType === OrderType.MO) return 'MO' as const;
    return 'ELO' as const;
  })();

  // 解析清仓订单类型配置
  const liquidationOrderType = (() => {
    const orderType = parseOrderTypeConfig(env, 'LIQUIDATION_ORDER_TYPE', 'MO');
    // 将 OrderType 枚举值转换回字符串以符合 GlobalConfig 类型
    if (orderType === OrderType.LO) return 'LO' as const;
    if (orderType === OrderType.ELO) return 'ELO' as const;
    return 'MO' as const;
  })();

  return {
    monitors,
    global: {
      doomsdayProtection: getBooleanConfig(env, 'DOOMSDAY_PROTECTION', true),
      debug: getBooleanConfig(env, 'DEBUG', false),
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
};


/**
 * 配置验证模块
 *
 * 功能：
 * - 验证 LongPort API 配置
 * - 验证所有监控标的的交易配置
 * - 验证标的有效性
 */

import { logger } from '../utils/logger/index.js';
import { MULTI_MONITOR_TRADING_CONFIG } from './config.trading.js';
import { createConfig } from './config.index.js';
import { createMarketDataClient } from '../services/quoteClient/index.js';
import type { MarketDataClient, ValidateAllConfigResult, MonitorConfig } from '../types/index.js';
import { formatSymbolDisplay } from '../utils/helpers/index.js';
import { formatSignalConfig } from '../utils/helpers/signalConfigParser.js';

/**
 * 配置验证错误类型
 */
export type ConfigValidationError = Error & {
  readonly name: 'ConfigValidationError';
  readonly missingFields: ReadonlyArray<string>;
};

/**
 * 创建配置验证错误
 * @param message 错误消息
 * @param missingFields 缺失的字段列表
 * @returns ConfigValidationError 错误对象
 */
export const createConfigValidationError = (
  message: string,
  missingFields: ReadonlyArray<string> = [],
): ConfigValidationError => {
  const error = new Error(message);
  return Object.assign(error, {
    name: 'ConfigValidationError' as const,
    missingFields,
  }) as ConfigValidationError;
};

/**
 * 验证结果接口
 */
interface ValidationResult {
  readonly valid: boolean;
  readonly errors: string[];
}

/**
 * 交易配置验证结果接口
 */
interface TradingValidationResult extends ValidationResult {
  readonly missingFields: string[];
}

/**
 * 标的验证结果接口
 */
interface SymbolValidationResult {
  readonly valid: boolean;
  readonly name: string | null;
  readonly error?: string;
}

/**
 * 验证 LongPort API 配置
 * @returns 验证结果
 */
async function validateLongPortConfig(): Promise<ValidationResult> {
  const errors: string[] = [];

  const appKey = process.env['LONGPORT_APP_KEY'];
  const appSecret = process.env['LONGPORT_APP_SECRET'];
  const accessToken = process.env['LONGPORT_ACCESS_TOKEN'];

  if (!appKey || appKey.trim() === '' || appKey === 'your_app_key_here') {
    errors.push('LONGPORT_APP_KEY 未配置');
  }

  if (!appSecret || appSecret.trim() === '' || appSecret === 'your_app_secret_here') {
    errors.push('LONGPORT_APP_SECRET 未配置');
  }

  if (!accessToken || accessToken.trim() === '' || accessToken === 'your_access_token_here') {
    errors.push('LONGPORT_ACCESS_TOKEN 未配置');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * 验证标的有效性
 * @param marketDataClient 行情客户端实例
 * @param symbol 标的代码
 * @param symbolLabel 标的标签（用于错误提示）
 * @returns 验证结果
 */
async function validateSymbol(
  marketDataClient: MarketDataClient,
  symbol: string,
  symbolLabel: string,
): Promise<SymbolValidationResult> {
  try {
    const quote = await marketDataClient.getLatestQuote(symbol);

    if (!quote) {
      return {
        valid: false,
        name: null,
        error: `${symbolLabel} ${symbol} 不存在或无法获取行情数据`,
      };
    }

    return {
      valid: true,
      name: quote.name ?? null,
    };
  } catch (err) {
    return {
      valid: false,
      name: null,
      error: `${symbolLabel} ${symbol} 验证失败: ${
        (err as Error)?.message ?? err
      }`,
    };
  }
}

/**
 * 验证单个监控标的的配置
 * @param config 监控标的配置
 * @param index 监控标的索引（用于错误提示）
 * @returns 验证结果
 */
function validateMonitorConfig(config: MonitorConfig, index: number): TradingValidationResult {
  const errors: string[] = [];
  const missingFields: string[] = [];
  const prefix = `监控标的 ${index}`;

  // 验证监控标的
  if (!config.monitorSymbol || config.monitorSymbol.trim() === '') {
    errors.push(`${prefix}: MONITOR_SYMBOL_${index} 未配置`);
    missingFields.push(`MONITOR_SYMBOL_${index}`);
  }

  // 验证做多标的
  if (!config.longSymbol || config.longSymbol.trim() === '') {
    errors.push(`${prefix}: LONG_SYMBOL_${index} 未配置`);
    missingFields.push(`LONG_SYMBOL_${index}`);
  }

  // 验证做空标的
  if (!config.shortSymbol || config.shortSymbol.trim() === '') {
    errors.push(`${prefix}: SHORT_SYMBOL_${index} 未配置`);
    missingFields.push(`SHORT_SYMBOL_${index}`);
  }

  // 验证目标买入金额
  if (!Number.isFinite(config.targetNotional) || config.targetNotional <= 0) {
    errors.push(`${prefix}: TARGET_NOTIONAL_${index} 未配置或无效（必须为正数）`);
    missingFields.push(`TARGET_NOTIONAL_${index}`);
  }

  // 验证最小买卖单位（可选，但如果有值必须为正数）
  if (config.longLotSize !== null && (!Number.isFinite(config.longLotSize) || config.longLotSize <= 0)) {
    errors.push(`${prefix}: LONG_LOT_SIZE_${index} 配置无效（必须为正数）`);
    missingFields.push(`LONG_LOT_SIZE_${index}`);
  }

  if (config.shortLotSize !== null && (!Number.isFinite(config.shortLotSize) || config.shortLotSize <= 0)) {
    errors.push(`${prefix}: SHORT_LOT_SIZE_${index} 配置无效（必须为正数）`);
    missingFields.push(`SHORT_LOT_SIZE_${index}`);
  }

  // 验证风险管理配置
  if (!Number.isFinite(config.maxPositionNotional) || config.maxPositionNotional <= 0) {
    errors.push(`${prefix}: MAX_POSITION_NOTIONAL_${index} 未配置或无效（必须为正数）`);
    missingFields.push(`MAX_POSITION_NOTIONAL_${index}`);
  }

  if (!Number.isFinite(config.maxDailyLoss) || config.maxDailyLoss < 0) {
    errors.push(`${prefix}: MAX_DAILY_LOSS_${index} 未配置或无效（必须为非负数）`);
    missingFields.push(`MAX_DAILY_LOSS_${index}`);
  }

  // 验证信号配置（必需）
  const signalConfigKeys = ['buycall', 'sellcall', 'buyput', 'sellput'] as const;
  const signalConfigEnvNames: Record<typeof signalConfigKeys[number], string> = {
    buycall: `SIGNAL_BUYCALL_${index}`,
    sellcall: `SIGNAL_SELLCALL_${index}`,
    buyput: `SIGNAL_BUYPUT_${index}`,
    sellput: `SIGNAL_SELLPUT_${index}`,
  };

  for (const key of signalConfigKeys) {
    const envName = signalConfigEnvNames[key];
    const signalConfig = config.signalConfig[key];

    if (!signalConfig?.conditionGroups || signalConfig.conditionGroups.length === 0) {
      errors.push(`${prefix}: ${envName} 未配置或解析失败（信号配置为必需项）`);
      missingFields.push(envName);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    missingFields,
  };
}

/**
 * 验证交易配置（验证所有监控标的）
 * @returns 验证结果
 */
function validateTradingConfig(): TradingValidationResult {
  const errors: string[] = [];
  const missingFields: string[] = [];

  // 验证 MONITOR_COUNT
  const monitorCount = MULTI_MONITOR_TRADING_CONFIG.monitors.length;
  if (monitorCount === 0) {
    errors.push('未找到任何监控标的配置，请设置 MONITOR_COUNT >= 1 并配置相应的监控标的');
    missingFields.push('MONITOR_COUNT');
    return {
      valid: false,
      errors,
      missingFields,
    };
  }

  // 验证每个监控标的的配置
  for (let i = 0; i < MULTI_MONITOR_TRADING_CONFIG.monitors.length; i++) {
    const config = MULTI_MONITOR_TRADING_CONFIG.monitors[i];
    if (!config) {
      continue;
    }
    const index = i + 1; // 索引从1开始（对应环境变量的 _1, _2 等）
    const result = validateMonitorConfig(config, index);
    errors.push(...result.errors);
    missingFields.push(...result.missingFields);
  }

  // 检测重复的交易标的（不允许多个监控标的使用相同的交易标的）
  const tradingSymbols = new Map<string, number>(); // symbol -> monitorIndex
  const duplicateSymbols: Array<{ symbol: string; index: number; previousIndex: number }> = [];

  for (let i = 0; i < MULTI_MONITOR_TRADING_CONFIG.monitors.length; i++) {
    const config = MULTI_MONITOR_TRADING_CONFIG.monitors[i];
    if (!config) {
      continue;
    }
    const index = i + 1;

    const normalizedLongSymbol = config.longSymbol.trim();
    const normalizedShortSymbol = config.shortSymbol.trim();

    // 检查做多标的
    if (tradingSymbols.has(normalizedLongSymbol)) {
      const previousIndex = tradingSymbols.get(normalizedLongSymbol)!;
      duplicateSymbols.push({
        symbol: normalizedLongSymbol,
        index,
        previousIndex,
      });
    } else {
      tradingSymbols.set(normalizedLongSymbol, index);
    }

    // 检查做空标的
    if (tradingSymbols.has(normalizedShortSymbol)) {
      const previousIndex = tradingSymbols.get(normalizedShortSymbol)!;
      duplicateSymbols.push({
        symbol: normalizedShortSymbol,
        index,
        previousIndex,
      });
    } else {
      tradingSymbols.set(normalizedShortSymbol, index);
    }
  }

  // 如果有重复标的，添加错误信息
  if (duplicateSymbols.length > 0) {
    for (const dup of duplicateSymbols) {
      errors.push(
        `交易标的重复：标的 ${dup.symbol} 被监控标的 ${dup.previousIndex} 和监控标的 ${dup.index} 重复使用。每个交易标的只能被一个监控标的使用。`,
      );
    }
    errors.push(
      '请检查配置，确保每个 LONG_SYMBOL 和 SHORT_SYMBOL 在所有监控标的中是唯一的。',
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    missingFields,
  };
}

/**
 * 验证所有配置
 * @returns 返回行情客户端实例
 * @throws {ConfigValidationError} 如果配置验证失败
 */
export async function validateAllConfig(): Promise<ValidateAllConfigResult> {
  logger.info('开始验证配置...');

  const longPortResult = await validateLongPortConfig();
  const tradingResult = validateTradingConfig();

  const allErrors = [...longPortResult.errors, ...tradingResult.errors];
  const allMissingFields = [...tradingResult.missingFields];

  if (allErrors.length > 0) {
    logger.error('配置验证失败！');
    logger.error('='.repeat(60));
    logger.error('发现以下配置问题：');
    allErrors.forEach((error, index) => {
      logger.error(`${index + 1}. ${error}`);
    });
    logger.error('='.repeat(60));
    logger.error('');
    logger.error('请检查 .env.local 文件，确保所有必需的配置项都已正确设置。');
    logger.error('参考 .env.example 文件了解配置说明。');
    logger.error('注意：配置必须使用索引后缀（_1, _2 等），即使只有一个监控标的也必须使用 _1 后缀。');
    logger.error('');

    throw createConfigValidationError(
      `配置验证失败：发现 ${allErrors.length} 个问题`,
      allMissingFields,
    );
  }

  // 验证标的有效性（创建 MarketDataClient 实例用于验证和后续使用）
  logger.info('验证标的有效性...');
  const config = createConfig();
  const marketDataClient = await createMarketDataClient({ config });

  const firstMonitorConfig = MULTI_MONITOR_TRADING_CONFIG.monitors[0];
  if (!firstMonitorConfig) {
    throw createConfigValidationError('未找到第一个监控标的配置', []);
  }

  // 验证所有监控标的的标的有效性（统一验证，避免重复）
  const symbolErrors: string[] = [];
  // 为每个监控标的保存验证结果（使用索引作为键的一部分）
  const symbolValidationResults = new Map<string, SymbolValidationResult>();

  for (let i = 0; i < MULTI_MONITOR_TRADING_CONFIG.monitors.length; i++) {
    const monitorConfig = MULTI_MONITOR_TRADING_CONFIG.monitors[i];
    if (!monitorConfig) {
      continue;
    }
    const index = i + 1;

    const allSymbolValidations = await Promise.all([
      validateSymbol(marketDataClient, monitorConfig.monitorSymbol, `监控标的 ${index}`),
      validateSymbol(marketDataClient, monitorConfig.longSymbol, `做多标的 ${index}`),
      validateSymbol(marketDataClient, monitorConfig.shortSymbol, `做空标的 ${index}`),
    ]);

    const [monitorValid, longValid, shortValid] = allSymbolValidations;

    // 存储每个监控标的的验证结果（使用索引区分不同监控标的）
    symbolValidationResults.set(`monitor_${i}`, monitorValid);
    symbolValidationResults.set(`long_${i}`, longValid);
    symbolValidationResults.set(`short_${i}`, shortValid);

    // 收集所有错误
    if (!monitorValid.valid && monitorValid.error) {
      symbolErrors.push(monitorValid.error);
    }
    if (!longValid.valid && longValid.error) {
      symbolErrors.push(longValid.error);
    }
    if (!shortValid.valid && shortValid.error) {
      symbolErrors.push(shortValid.error);
    }
  }

  if (symbolErrors.length > 0) {
    logger.error('标的验证失败！');
    logger.error('='.repeat(60));
    logger.error('发现以下标的问题：');
    symbolErrors.forEach((error, index) => {
      logger.error(`${index + 1}. ${error}`);
    });
    logger.error('='.repeat(60));
    logger.error('');
    logger.error('请检查 .env.local 文件中的标的代码配置，确保：');
    logger.error('1. 标的代码正确且存在');
    logger.error('2. 标的正在正常交易');
    logger.error('3. API 有权限访问该标的行情');
    logger.error('');

    throw createConfigValidationError(
      `标的验证失败：发现 ${symbolErrors.length} 个问题`,
      [],
    );
  }

  logger.info('配置验证通过，当前配置如下：');
  logger.info(`监控标的数量: ${MULTI_MONITOR_TRADING_CONFIG.monitors.length}`);

  // 显示所有监控标的的配置
  for (let i = 0; i < MULTI_MONITOR_TRADING_CONFIG.monitors.length; i++) {
    const monitorConfig = MULTI_MONITOR_TRADING_CONFIG.monitors[i];
    if (!monitorConfig) {
      continue;
    }
    const index = i + 1;

    // 为每个监控标的获取标的名称（从验证结果中获取）
    const monitorResult = symbolValidationResults.get(`monitor_${i}`);
    const longResult = symbolValidationResults.get(`long_${i}`);
    const shortResult = symbolValidationResults.get(`short_${i}`);
    const monitorName = monitorResult?.name ?? null;
    const longName = longResult?.name ?? null;
    const shortName = shortResult?.name ?? null;

    logger.info(`\n监控标的 ${index}:`);
    logger.info(
      `监控标的: ${formatSymbolDisplay(monitorConfig.monitorSymbol, monitorName)}`,
    );
    logger.info(
      `做多标的: ${formatSymbolDisplay(monitorConfig.longSymbol, longName)}`,
    );
    logger.info(
      `做空标的: ${formatSymbolDisplay(monitorConfig.shortSymbol, shortName)}`,
    );
    logger.info(`目标买入金额: ${monitorConfig.targetNotional} HKD`);
    logger.info(`最大持仓市值: ${monitorConfig.maxPositionNotional} HKD`);
    logger.info(`单日最大亏损: ${monitorConfig.maxDailyLoss} HKD`);

    // 显示单标的浮亏保护配置
    if (monitorConfig.maxUnrealizedLossPerSymbol && monitorConfig.maxUnrealizedLossPerSymbol > 0) {
      logger.info(
        `单标的浮亏保护阈值: ${monitorConfig.maxUnrealizedLossPerSymbol} HKD`,
      );
    } else {
      logger.info('单标的浮亏保护: 已禁用');
    }

    logger.info(`同方向买入时间间隔: ${monitorConfig.buyIntervalSeconds} 秒`);

    // 显示延迟验证配置
    const verificationConfig = monitorConfig.verificationConfig;
    if (verificationConfig) {
      // 买入信号验证配置
      if (
        verificationConfig.buy.delaySeconds > 0 &&
        verificationConfig.buy.indicators &&
        verificationConfig.buy.indicators.length > 0
      ) {
        logger.info(`买入信号延迟验证时间: ${verificationConfig.buy.delaySeconds} 秒`);
        logger.info(`买入信号延迟验证指标: ${verificationConfig.buy.indicators.join(', ')}`);
      } else {
        logger.info('买入信号延迟验证: 已禁用');
      }

      // 卖出信号验证配置
      if (
        verificationConfig.sell.delaySeconds > 0 &&
        verificationConfig.sell.indicators &&
        verificationConfig.sell.indicators.length > 0
      ) {
        logger.info(`卖出信号延迟验证时间: ${verificationConfig.sell.delaySeconds} 秒`);
        logger.info(`卖出信号延迟验证指标: ${verificationConfig.sell.indicators.join(', ')}`);
      } else {
        logger.info('卖出信号延迟验证: 已禁用');
      }
    }

    // 显示信号配置
    logger.info('信号配置:');
    if (monitorConfig.signalConfig.buycall) {
      logger.info(
        `BUYCALL: ${formatSignalConfig(monitorConfig.signalConfig.buycall)}`,
      );
    }
    if (monitorConfig.signalConfig.sellcall) {
      logger.info(
        `SELLCALL: ${formatSignalConfig(monitorConfig.signalConfig.sellcall)}`,
      );
    }
    if (monitorConfig.signalConfig.buyput) {
      logger.info(`BUYPUT: ${formatSignalConfig(monitorConfig.signalConfig.buyput)}`);
    }
    if (monitorConfig.signalConfig.sellput) {
      logger.info(`SELLPUT: ${formatSignalConfig(monitorConfig.signalConfig.sellput)}`);
    }
  }

  logger.info('');
  logger.info(
    `是否启动末日保护: ${MULTI_MONITOR_TRADING_CONFIG.global.doomsdayProtection ? '是' : '否'}`,
  );
  logger.info('');

  // 返回行情客户端实例供后续使用
  return {
    marketDataClient, // 返回已创建的实例，避免重复创建
  };
}

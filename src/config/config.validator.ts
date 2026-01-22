/**
 * 配置验证模块
 *
 * 功能：
 * - 验证 LongPort API 配置
 * - 验证所有监控标的的交易配置
 * - 验证标的有效性
 */

import { logger } from '../utils/logger/index.js';
import { createConfig } from './config.index.js';
import { createMarketDataClient } from '../services/quoteClient/index.js';
import type { MarketDataClient, ValidateAllConfigResult, MonitorConfig, MultiMonitorTradingConfig } from '../types/index.js';
import { formatSymbolDisplay, normalizeHKSymbol, formatError } from '../utils/helpers/index.js';
import { formatSignalConfig } from '../utils/helpers/signalConfigParser.js';
import type { ConfigValidationError } from './types.js';

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
  readonly lotSize?: number | undefined;
  readonly error?: string | undefined;
}

/**
 * 验证 LongPort API 配置
 * @returns 验证结果
 */
async function validateLongPortConfig(env: NodeJS.ProcessEnv): Promise<ValidationResult> {
  const errors: string[] = [];

  const appKey = env['LONGPORT_APP_KEY'];
  const appSecret = env['LONGPORT_APP_SECRET'];
  const accessToken = env['LONGPORT_ACCESS_TOKEN'];

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
 * 验证标的有效性（从已获取的行情数据中验证）
 * @param quote 行情数据（可能为 null）
 * @param symbol 标的代码
 * @param symbolLabel 标的标签（用于错误提示）
 * @param requireLotSize 是否要求必须有 lotSize（交易标的需要，监控标的不需要）
 * @returns 验证结果
 */
function validateSymbolFromQuote(
  quote: import('../types/index.js').Quote | null,
  symbol: string,
  symbolLabel: string,
  requireLotSize: boolean = false,
): SymbolValidationResult {
  if (!quote) {
    return {
      valid: false,
      name: null,
      error: `${symbolLabel} ${symbol} 不存在或无法获取行情数据`,
    };
  }

  const errors: string[] = [];

  // 验证名称（所有标的都建议有名称，但不阻止程序运行）
  if (!quote.name) {
    // 名称缺失只是警告，不阻止验证通过
    logger.warn(`${symbolLabel} ${symbol} 缺少中文名称信息`);
  }

  // 验证 lotSize（交易标的必须有）
  if (requireLotSize && (quote.lotSize === undefined || quote.lotSize === null || quote.lotSize <= 0)) {
    errors.push(`${symbolLabel} ${symbol} 缺少每手股数(lotSize)信息，无法进行交易计算`);
  }

  if (errors.length > 0) {
    return {
      valid: false,
      name: quote.name ?? null,
      lotSize: quote.lotSize,
      error: errors.join('；'),
    };
  }

  return {
    valid: true,
    name: quote.name ?? null,
    lotSize: quote.lotSize,
  };
}

/**
 * 批量验证标的有效性
 * @param marketDataClient 行情客户端实例
 * @param symbols 标的代码数组
 * @param symbolLabels 标的标签数组（用于错误提示，与 symbols 一一对应）
 * @param requireLotSizeFlags 是否要求 lotSize 的标志数组（与 symbols 一一对应）
 * @returns 验证结果数组
 */
async function validateSymbolsBatch(
  marketDataClient: MarketDataClient,
  symbols: ReadonlyArray<string>,
  symbolLabels: ReadonlyArray<string>,
  requireLotSizeFlags: ReadonlyArray<boolean>,
): Promise<ReadonlyArray<SymbolValidationResult>> {
  try {
    // 先批量缓存所有标的的静态信息（一次 API 调用）
    await marketDataClient.cacheStaticInfo(symbols);

    // 然后使用 getQuotes 批量获取所有标的的行情（一次 API 调用）
    // 此时 getQuotes 会从缓存读取 staticInfo，不会再调用 staticInfo API
    const quotesMap = await marketDataClient.getQuotes(symbols);

    // 为每个标的生成验证结果
    return symbols.map((symbol, index) => {
      const symbolLabel = symbolLabels[index];
      const requireLotSize = requireLotSizeFlags[index] ?? false;
      if (!symbolLabel) {
        return {
          valid: false,
          name: null,
          error: `标的 ${symbol} 缺少标签信息`,
        };
      }
      // 从 quotesMap 中获取行情（使用规范化后的标的代码作为 key）
      const normalizedSymbol = normalizeHKSymbol(symbol);
      const quote = quotesMap.get(normalizedSymbol) ?? null;
      return validateSymbolFromQuote(quote, symbol, symbolLabel, requireLotSize);
    });
  } catch (err) {
    // 如果批量获取失败，为所有标的返回错误结果
    return symbols.map((symbol, index) => ({
      valid: false,
      name: null,
      error: `${symbolLabels[index]} ${symbol} 验证失败: ${formatError(err)}`,
    }));
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
function validateTradingConfig(tradingConfig: MultiMonitorTradingConfig): TradingValidationResult {
  const errors: string[] = [];
  const missingFields: string[] = [];

  // 验证 MONITOR_COUNT
  const monitorCount = tradingConfig.monitors.length;
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
  for (const config of tradingConfig.monitors) {
    if (!config) {
      continue;
    }
    // 使用配置中保存的原始索引（对应环境变量的 _1, _2 等后缀）
    const result = validateMonitorConfig(config, config.originalIndex);
    errors.push(...result.errors);
    missingFields.push(...result.missingFields);
  }

  // 检测重复的交易标的（不允许多个监控标的使用相同的交易标的）
  const tradingSymbols = new Map<string, number>(); // symbol -> originalIndex
  const duplicateSymbols: Array<{ symbol: string; index: number; previousIndex: number }> = [];

  for (const config of tradingConfig.monitors) {
    if (!config) {
      continue;
    }
    // 使用配置中保存的原始索引
    const index = config.originalIndex;

    // 统一规范化，避免 "12345" 与 "12345.HK" 这种形式绕过重复检测
    const normalizedLongSymbol = normalizeHKSymbol(config.longSymbol.trim());
    const normalizedShortSymbol = normalizeHKSymbol(config.shortSymbol.trim());

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
export async function validateAllConfig({
  env,
  tradingConfig,
}: {
  env: NodeJS.ProcessEnv;
  tradingConfig: MultiMonitorTradingConfig;
}): Promise<ValidateAllConfigResult> {
  logger.info('开始验证配置...');

  const longPortResult = await validateLongPortConfig(env);
  const tradingResult = validateTradingConfig(tradingConfig);

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

  const firstMonitorConfig = tradingConfig.monitors[0];
  if (!firstMonitorConfig) {
    throw createConfigValidationError('未找到第一个监控标的配置', []);
  }

  // 验证所有监控标的的标的有效性（使用批量获取，避免多次 API 调用）
  const symbolErrors: string[] = [];
  // 为每个监控标的保存验证结果（使用索引作为键的一部分）
  const symbolValidationResults = new Map<string, SymbolValidationResult>();

  // 收集所有需要验证的标的代码和标签（在创建 marketDataClient 之前收集）
  const allSymbols: string[] = [];
  const allSymbolLabels: string[] = [];
  const allRequireLotSizeFlags: boolean[] = [];
  // 使用原始索引作为键（而非数组索引），确保跳过配置时索引正确
  const symbolIndexMap = new Map<number, { monitorIndex: number; longIndex: number; shortIndex: number }>();

  for (const monitorConfig of tradingConfig.monitors) {
    if (!monitorConfig) {
      continue;
    }
    // 使用配置中保存的原始索引
    const index = monitorConfig.originalIndex;

    // 记录每个监控标的的三个标的在批量数组中的索引位置
    const monitorIndex = allSymbols.length;
    allSymbols.push(monitorConfig.monitorSymbol);
    allSymbolLabels.push(`监控标的 ${index}`);
    allRequireLotSizeFlags.push(false); // 监控标的不需要 lotSize

    const longIndex = allSymbols.length;
    allSymbols.push(monitorConfig.longSymbol);
    allSymbolLabels.push(`做多标的 ${index}`);
    allRequireLotSizeFlags.push(true); // 交易标的需要 lotSize

    const shortIndex = allSymbols.length;
    allSymbols.push(monitorConfig.shortSymbol);
    allSymbolLabels.push(`做空标的 ${index}`);
    allRequireLotSizeFlags.push(true); // 交易标的需要 lotSize

    // 使用原始索引作为键
    symbolIndexMap.set(index, { monitorIndex, longIndex, shortIndex });
  }

  // 创建行情客户端（传入需要订阅的标的列表，自动初始化 WebSocket 订阅）
  const config = createConfig({ env });
  const marketDataClient = await createMarketDataClient({
    config,
    symbols: allSymbols, // 传入需要订阅的标的列表
  });

  // 批量验证所有标的（从本地缓存读取，已在 createMarketDataClient 中初始化）
  const allValidationResults = await validateSymbolsBatch(marketDataClient, allSymbols, allSymbolLabels, allRequireLotSizeFlags);

  // 将验证结果分配到各个监控标的
  for (const monitorConfig of tradingConfig.monitors) {
    if (!monitorConfig) {
      continue;
    }
    // 使用原始索引作为键查找
    const indices = symbolIndexMap.get(monitorConfig.originalIndex);
    if (!indices) {
      continue;
    }

    const monitorValid = allValidationResults[indices.monitorIndex];
    const longValid = allValidationResults[indices.longIndex];
    const shortValid = allValidationResults[indices.shortIndex];

    if (!monitorValid || !longValid || !shortValid) {
      continue;
    }

    // 存储每个监控标的的验证结果（使用原始索引区分不同监控标的）
    symbolValidationResults.set(`monitor_${monitorConfig.originalIndex}`, monitorValid);
    symbolValidationResults.set(`long_${monitorConfig.originalIndex}`, longValid);
    symbolValidationResults.set(`short_${monitorConfig.originalIndex}`, shortValid);

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
    logger.error('4. 交易标的（做多/做空）必须能获取到每手股数(lotSize)信息');
    logger.error('');

    throw createConfigValidationError(
      `标的验证失败：发现 ${symbolErrors.length} 个问题`,
      [],
    );
  }

  logger.info('配置验证通过，当前配置如下：');
  logger.info(`监控标的数量: ${tradingConfig.monitors.length}`);

  // 显示所有监控标的的配置
  for (const monitorConfig of tradingConfig.monitors) {
    if (!monitorConfig) {
      continue;
    }
    // 使用原始索引
    const index = monitorConfig.originalIndex;

    // 为每个监控标的获取标的名称（从验证结果中获取，使用原始索引）
    const monitorResult = symbolValidationResults.get(`monitor_${index}`);
    const longResult = symbolValidationResults.get(`long_${index}`);
    const shortResult = symbolValidationResults.get(`short_${index}`);
    const monitorName = monitorResult?.name ?? null;
    const longName = longResult?.name ?? null;
    const shortName = shortResult?.name ?? null;

    logger.info(`\n监控标的 ${index}:`);
    logger.info(
      `监控标的: ${formatSymbolDisplay(monitorConfig.monitorSymbol, monitorName)}`,
    );
    logger.info(
      `做多标的: ${formatSymbolDisplay(monitorConfig.longSymbol, longName)} (每手 ${longResult?.lotSize ?? '未知'} 股)`,
    );
    logger.info(
      `做空标的: ${formatSymbolDisplay(monitorConfig.shortSymbol, shortName)} (每手 ${shortResult?.lotSize ?? '未知'} 股)`,
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
    `是否启动末日保护: ${tradingConfig.global.doomsdayProtection ? '是' : '否'}`,
  );
  logger.info('');

  // 返回行情客户端实例供后续使用
  return {
    marketDataClient, // 返回已创建的实例，避免重复创建
  };
}

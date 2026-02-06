/**
 * 配置验证模块
 *
 * 验证 LongPort API 凭证、交易配置完整性（不触发行情订阅）
 */
import { logger } from '../utils/logger/index.js';
import { getStringConfig } from './utils.js';
import { isSymbolWithRegion } from '../utils/helpers/index.js';
import { formatSignalConfig } from '../utils/helpers/signalConfigParser.js';
import type {
  LiquidationCooldownConfig,
  MonitorConfig,
  MultiMonitorTradingConfig,
  Quote,
} from '../types/index.js';
import type {
  ConfigValidationError,
  DuplicateSymbol,
  RuntimeSymbolValidationInput,
  RuntimeSymbolValidationResult,
  SignalConfigKey,
  SymbolValidationContext,
  TradingValidationResult,
  ValidationResult,
} from './types.js';

/** 创建配置验证错误对象 */
function createConfigValidationError(
  message: string,
  missingFields: ReadonlyArray<string> = [],
): ConfigValidationError {
  const error = new Error(message);
  return Object.assign(error, {
    name: 'ConfigValidationError' as const,
    missingFields,
  });
}

function formatSymbolFormatError(prefix: string, envKey: string, symbol: string): string {
  return `${prefix}: ${envKey} 必须使用 ticker.region 格式（如 68711.HK），当前值: ${symbol}`;
}

function formatLiquidationCooldownConfig(config: LiquidationCooldownConfig | null): string {
  if (!config) {
    return '未配置（不冷却）';
  }
  if (config.mode === 'minutes') {
    return `${config.minutes} 分钟`;
  }
  return config.mode;
}

function validateRequiredSymbol({
  prefix,
  symbol,
  envKey,
  errors,
  missingFields,
}: SymbolValidationContext): void {
  if (!symbol || symbol.trim() === '') {
    errors.push(`${prefix}: ${envKey} 未配置`);
    missingFields.push(envKey);
    return;
  }
  if (!isSymbolWithRegion(symbol)) {
    errors.push(formatSymbolFormatError(prefix, envKey, symbol));
  }
}

/**
 * 记录交易标的使用情况并检测重复配置。
 */
function recordTradingSymbolUsage(
  symbol: string,
  index: number,
  tradingSymbols: Map<string, number>,
  duplicateSymbols: DuplicateSymbol[],
): void {
  const previousIndex = tradingSymbols.get(symbol);
  if (previousIndex !== undefined) {
    duplicateSymbols.push({
      symbol,
      index,
      previousIndex,
    });
    return;
  }
  tradingSymbols.set(symbol, index);
}

/** 验证 LongPort API 凭证是否已配置 */
async function validateLongPortConfig(env: NodeJS.ProcessEnv): Promise<ValidationResult> {
  const errors: string[] = [];

  const requiredConfigs = [
    { key: 'LONGPORT_APP_KEY', placeholder: 'your_app_key_here' },
    { key: 'LONGPORT_APP_SECRET', placeholder: 'your_app_secret_here' },
    { key: 'LONGPORT_ACCESS_TOKEN', placeholder: 'your_access_token_here' },
  ];

  for (const config of requiredConfigs) {
    const value = env[config.key];
    if (!value || value.trim() === '' || value === config.placeholder) {
      errors.push(`${config.key} 未配置`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/** 从行情数据验证标的有效性（交易标的需要 lotSize，监控标的不需要） */
function validateSymbolFromQuote(
  quote: Quote | null,
  symbol: string,
  symbolLabel: string,
  requireLotSize: boolean = false,
): { readonly valid: boolean; readonly error?: string } {
  if (!quote) {
    return {
      valid: false,
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
      error: errors.join('；'),
    };
  }

  return { valid: true };
}

/** 验证单个监控标的的配置完整性 */
function validateMonitorConfig(
  config: MonitorConfig,
  index: number,
  env: NodeJS.ProcessEnv,
): TradingValidationResult {
  const errors: string[] = [];
  const missingFields: string[] = [];
  const prefix = `监控标的 ${index}`;

  // 验证监控标的
  validateRequiredSymbol({
    prefix,
    symbol: config.monitorSymbol,
    envKey: `MONITOR_SYMBOL_${index}`,
    errors,
    missingFields,
  });

  const autoSearchEnabled = config.autoSearchConfig.autoSearchEnabled;

  // 验证订单归属映射
  if (!config.orderOwnershipMapping || config.orderOwnershipMapping.length === 0) {
    const mappingKey = `ORDER_OWNERSHIP_MAPPING_${index}`;
    errors.push(`${prefix}: ${mappingKey} 未配置或为空（用于 stockName 归属解析）`);
    missingFields.push(mappingKey);
  }

  // 自动寻标关闭时，做多/做空标的必须配置
  if (!autoSearchEnabled) {
    // 验证做多标的
    validateRequiredSymbol({
      prefix,
      symbol: config.longSymbol,
      envKey: `LONG_SYMBOL_${index}`,
      errors,
      missingFields,
    });

    // 验证做空标的
    validateRequiredSymbol({
      prefix,
      symbol: config.shortSymbol,
      envKey: `SHORT_SYMBOL_${index}`,
      errors,
      missingFields,
    });
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

  const liquidationCooldownEnvKey = `LIQUIDATION_COOLDOWN_MINUTES_${index}`;
  const configuredCooldown = getStringConfig(env, liquidationCooldownEnvKey);
  if (configuredCooldown && !config.liquidationCooldown) {
    errors.push(
      `${prefix}: ${liquidationCooldownEnvKey} 无效（范围 1-120 或 half-day / one-day）`,
    );
  } else if (config.liquidationCooldown?.mode === 'minutes') {
    if (
      !Number.isFinite(config.liquidationCooldown.minutes) ||
      config.liquidationCooldown.minutes < 1 ||
      config.liquidationCooldown.minutes > 120
    ) {
      errors.push(
        `${prefix}: ${liquidationCooldownEnvKey} 无效（范围 1-120 或 half-day / one-day）`,
      );
    }
  }

  // 验证信号配置（必需）
  const signalConfigKeys: ReadonlyArray<SignalConfigKey> = [
    'buycall',
    'sellcall',
    'buyput',
    'sellput',
  ];
  const signalConfigEnvNames: Record<SignalConfigKey, string> = {
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

  if (autoSearchEnabled) {
    const autoSearchConfig = config.autoSearchConfig;
    const requiredNumberFields = [
      {
        value: autoSearchConfig.autoSearchMinPriceBull,
        envKey: `AUTO_SEARCH_MIN_PRICE_BULL_${index}`,
      },
      {
        value: autoSearchConfig.autoSearchMinPriceBear,
        envKey: `AUTO_SEARCH_MIN_PRICE_BEAR_${index}`,
      },
      {
        value: autoSearchConfig.autoSearchMinTurnoverPerMinuteBull,
        envKey: `AUTO_SEARCH_MIN_TURNOVER_PER_MINUTE_BULL_${index}`,
      },
      {
        value: autoSearchConfig.autoSearchMinTurnoverPerMinuteBear,
        envKey: `AUTO_SEARCH_MIN_TURNOVER_PER_MINUTE_BEAR_${index}`,
      },
    ];

    for (const field of requiredNumberFields) {
      if (field.value === null || !Number.isFinite(field.value)) {
        errors.push(`${prefix}: ${field.envKey} 未配置或无效`);
        missingFields.push(field.envKey);
      }
    }

    if (!Number.isFinite(autoSearchConfig.autoSearchExpiryMinMonths) || autoSearchConfig.autoSearchExpiryMinMonths < 1) {
      errors.push(`${prefix}: AUTO_SEARCH_EXPIRY_MIN_MONTHS_${index} 无效（必须 >= 1）`);
      missingFields.push(`AUTO_SEARCH_EXPIRY_MIN_MONTHS_${index}`);
    }

    if (!Number.isFinite(autoSearchConfig.autoSearchOpenDelayMinutes) || autoSearchConfig.autoSearchOpenDelayMinutes < 0) {
      errors.push(`${prefix}: AUTO_SEARCH_OPEN_DELAY_MINUTES_${index} 无效（必须 >= 0）`);
      missingFields.push(`AUTO_SEARCH_OPEN_DELAY_MINUTES_${index}`);
    }

    const bullRange = autoSearchConfig.switchDistanceRangeBull;
    if (!bullRange || !Number.isFinite(bullRange.min) || !Number.isFinite(bullRange.max) || bullRange.min > bullRange.max) {
      errors.push(`${prefix}: SWITCH_DISTANCE_RANGE_BULL_${index} 未配置或无效（格式 min,max 且 min<=max）`);
      missingFields.push(`SWITCH_DISTANCE_RANGE_BULL_${index}`);
    }

    const bearRange = autoSearchConfig.switchDistanceRangeBear;
    if (!bearRange || !Number.isFinite(bearRange.min) || !Number.isFinite(bearRange.max) || bearRange.min > bearRange.max) {
      errors.push(`${prefix}: SWITCH_DISTANCE_RANGE_BEAR_${index} 未配置或无效（格式 min,max 且 min<=max）`);
      missingFields.push(`SWITCH_DISTANCE_RANGE_BEAR_${index}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    missingFields,
  };
}

/** 验证所有监控标的的交易配置（含重复标的检测） */
function validateTradingConfig(
  tradingConfig: MultiMonitorTradingConfig,
  env: NodeJS.ProcessEnv,
): TradingValidationResult {
  const errors: string[] = [];
  const missingFields: string[] = [];

  // 验证是否存在监控标的配置
  const monitorCount = tradingConfig.monitors.length;
  if (monitorCount === 0) {
    errors.push('未找到任何监控标的配置，请配置 MONITOR_SYMBOL_1 及相应的交易参数');
    missingFields.push('MONITOR_SYMBOL_1');
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
    const result = validateMonitorConfig(config, config.originalIndex, env);
    errors.push(...result.errors);
    missingFields.push(...result.missingFields);
  }

  // 检测订单归属映射冲突（同一缩写不能归属多个监控标的）
  const ownershipAliases = new Map<string, string>();
  const ownershipConflicts: Array<{ alias: string; current: string; existing: string }> = [];
  for (const config of tradingConfig.monitors) {
    if (!config) {
      continue;
    }
    for (const alias of config.orderOwnershipMapping) {
      const normalizedAlias = alias.trim().toUpperCase();
      if (!normalizedAlias) {
        continue;
      }
      const existing = ownershipAliases.get(normalizedAlias);
      if (existing && existing !== config.monitorSymbol) {
        ownershipConflicts.push({
          alias: normalizedAlias,
          current: config.monitorSymbol,
          existing,
        });
        continue;
      }
      ownershipAliases.set(normalizedAlias, config.monitorSymbol);
    }
  }
  if (ownershipConflicts.length > 0) {
    for (const conflict of ownershipConflicts) {
      errors.push(
        `订单归属映射冲突：缩写 ${conflict.alias} 同时映射到 ${conflict.existing} 与 ${conflict.current}`,
      );
    }
  }

  // 检测重复的交易标的（不允许多个监控标的使用相同的交易标的）
  const tradingSymbols = new Map<string, number>(); // symbol -> originalIndex
  const duplicateSymbols: DuplicateSymbol[] = [];

  for (const config of tradingConfig.monitors) {
    if (!config) {
      continue;
    }
    if (config.autoSearchConfig.autoSearchEnabled) {
      continue;
    }
    // 使用配置中保存的原始索引
    const index = config.originalIndex;

    const longSymbol = config.longSymbol;
    const shortSymbol = config.shortSymbol;

    // 检查做多标的
    if (longSymbol) {
      recordTradingSymbolUsage(longSymbol, index, tradingSymbols, duplicateSymbols);
    }

    // 检查做空标的
    if (shortSymbol) {
      recordTradingSymbolUsage(shortSymbol, index, tradingSymbols, duplicateSymbols);
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

  // 验证开盘保护配置（分别校验早盘和午盘）
  const { morning, afternoon } = tradingConfig.global.openProtection;

  if (morning.enabled) {
    if (morning.minutes == null) {
      errors.push('MORNING_OPENING_PROTECTION_MINUTES 未配置（启用早盘保护时为必填，范围 1-60）');
      missingFields.push('MORNING_OPENING_PROTECTION_MINUTES');
    } else if (morning.minutes < 1 || morning.minutes > 60) {
      errors.push('MORNING_OPENING_PROTECTION_MINUTES 无效（范围 1-60）');
    }
  }

  if (afternoon.enabled) {
    if (afternoon.minutes == null) {
      errors.push('AFTERNOON_OPENING_PROTECTION_MINUTES 未配置（启用午盘保护时为必填，范围 1-60）');
      missingFields.push('AFTERNOON_OPENING_PROTECTION_MINUTES');
    } else if (afternoon.minutes < 1 || afternoon.minutes > 60) {
      errors.push('AFTERNOON_OPENING_PROTECTION_MINUTES 无效（范围 1-60）');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    missingFields,
  };
}

/**
 * 验证所有配置并返回行情客户端
 * @throws {ConfigValidationError} 配置验证失败时抛出
 */
export async function validateAllConfig({
  env,
  tradingConfig,
}: {
  env: NodeJS.ProcessEnv;
  tradingConfig: MultiMonitorTradingConfig;
}): Promise<void> {
  logger.info('开始验证配置...');

  const longPortResult = await validateLongPortConfig(env);
  const tradingResult = validateTradingConfig(tradingConfig, env);

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
    logger.error('注意：配置必须使用索引后缀（_1, _2 等），系统会自动检测存在的监控标的配置。');
    logger.error('');

    throw createConfigValidationError(
      `配置验证失败：发现 ${allErrors.length} 个问题`,
      allMissingFields,
    );
  }

  logger.info('配置验证通过，当前配置如下：');
  logger.info(`监控标的数量: ${tradingConfig.monitors.length}`);

  for (const monitorConfig of tradingConfig.monitors) {
    if (!monitorConfig) {
      continue;
    }
    const index = monitorConfig.originalIndex;
    const autoSearchEnabled = monitorConfig.autoSearchConfig.autoSearchEnabled;

    logger.info(`\n监控标的 ${index}:`);
    logger.info(`监控标的: ${monitorConfig.monitorSymbol}`);
    logger.info(`订单归属映射: ${monitorConfig.orderOwnershipMapping.join(', ')}`);
    if (autoSearchEnabled) {
      logger.info('自动寻标: 已启用（交易标的由席位动态决定）');
      logger.info('做多标的: 自动寻标');
      logger.info('做空标的: 自动寻标');
    } else {
      logger.info(`做多标的: ${monitorConfig.longSymbol}`);
      logger.info(`做空标的: ${monitorConfig.shortSymbol}`);
    }
    logger.info(`目标买入金额: ${monitorConfig.targetNotional} HKD`);
    logger.info(`最大持仓市值: ${monitorConfig.maxPositionNotional} HKD`);
    logger.info(`单日最大亏损: ${monitorConfig.maxDailyLoss} HKD`);

    if (monitorConfig.maxUnrealizedLossPerSymbol && monitorConfig.maxUnrealizedLossPerSymbol > 0) {
      logger.info(
        `单标的浮亏保护阈值: ${monitorConfig.maxUnrealizedLossPerSymbol} HKD`,
      );
    } else {
      logger.info('单标的浮亏保护: 已禁用');
    }

    logger.info(`同方向买入时间间隔: ${monitorConfig.buyIntervalSeconds} 秒`);
    logger.info(
      `保护性清仓后买入冷却: ${formatLiquidationCooldownConfig(monitorConfig.liquidationCooldown)}`,
    );

    const verificationConfig = monitorConfig.verificationConfig;
    if (verificationConfig) {
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
}

export function validateRuntimeSymbolsFromQuotesMap({
  inputs,
  quotesMap,
}: {
  readonly inputs: ReadonlyArray<RuntimeSymbolValidationInput>;
  readonly quotesMap: ReadonlyMap<string, Quote | null>;
}): RuntimeSymbolValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const input of inputs) {
    const quote = quotesMap.get(input.symbol) ?? null;
    const result = validateSymbolFromQuote(
      quote,
      input.symbol,
      input.label,
      input.requireLotSize,
    );
    if (!result.valid) {
      const message = result.error ?? `${input.label} ${input.symbol} 验证失败`;
      if (input.required) {
        errors.push(message);
      } else {
        warnings.push(message);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

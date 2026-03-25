/**
 * validator 配置校验模块。
 *
 * 负责聚合 Longbridge 认证校验与交易配置校验，
 * 保持原有错误收集顺序、日志输出语义与运行时标的校验行为不变。
 */
import { logger } from '../../utils/logger/index.js';
import { createConfigValidationError, formatSignalConfig } from '../utils.js';
import { readAuthMode } from '../auth/utils.js';
import type { MultiMonitorTradingConfig } from '../../types/config.js';
import type { Quote } from '../../types/quote.js';
import type { RuntimeSymbolValidationInput, RuntimeSymbolValidationResult } from '../types.js';
import type { DuplicateSymbol, ValidationResult } from './types.js';
import {
  formatLiquidationCooldownConfig,
  recordTradingSymbolUsage,
  validateCriticalBoundedNumberConfig,
  validateLongbridgeAuthConfig,
  validateMonitorConfig,
  validateMonitorSymbolIndexContinuity,
  validateSymbolFromQuote,
} from './utils.js';

/**
 * 聚合校验多监控交易配置。
 *
 * 保持 monitor 连续性、单 monitor 校验、跨 monitor 冲突检测与全局配置校验的既有顺序，
 * 以确保错误收集结果与日志语义不发生偏移。
 *
 * @param tradingConfig 多监控标的交易配置
 * @param env 进程环境变量
 * @returns 聚合后的校验结果
 */
function validateTradingConfig(
  tradingConfig: MultiMonitorTradingConfig,
  env: NodeJS.ProcessEnv,
): ValidationResult {
  let errors: ReadonlyArray<string> = [];
  let missingFields: ReadonlyArray<string> = [];

  const monitorCount = tradingConfig.monitors.length;
  if (monitorCount === 0) {
    errors = [...errors, '未找到任何监控标的配置，请配置 MONITOR_SYMBOL_1 及相应的交易参数'];
    missingFields = [...missingFields, 'MONITOR_SYMBOL_1'];
    return {
      valid: false,
      errors,
      missingFields,
    };
  }

  const monitorIndexContinuityResult = validateMonitorSymbolIndexContinuity(env);
  errors = [...errors, ...monitorIndexContinuityResult.errors];
  missingFields = [...missingFields, ...monitorIndexContinuityResult.missingFields];

  for (const config of tradingConfig.monitors) {
    const result = validateMonitorConfig(config, config.originalIndex, env);
    errors = [...errors, ...result.errors];
    missingFields = [...missingFields, ...result.missingFields];
  }

  const ownershipAliases = new Map<string, string>();
  const ownershipConflicts: { alias: string; current: string; existing: string }[] = [];
  for (const config of tradingConfig.monitors) {
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
      errors = [
        ...errors,
        `订单归属映射冲突：缩写 ${conflict.alias} 同时映射到 ${conflict.existing} 与 ${conflict.current}`,
      ];
    }
  }

  const tradingSymbols = new Map<string, number>();
  const duplicateSymbols: DuplicateSymbol[] = [];
  for (const config of tradingConfig.monitors) {
    if (config.autoSearchConfig.autoSearchEnabled) {
      continue;
    }

    const index = config.originalIndex;
    const longSymbol = config.longSymbol;
    const shortSymbol = config.shortSymbol;

    if (longSymbol) {
      recordTradingSymbolUsage(longSymbol, index, tradingSymbols, duplicateSymbols);
    }

    if (shortSymbol) {
      recordTradingSymbolUsage(shortSymbol, index, tradingSymbols, duplicateSymbols);
    }
  }

  if (duplicateSymbols.length > 0) {
    for (const dup of duplicateSymbols) {
      errors = [
        ...errors,
        `交易标的重复：标的 ${dup.symbol} 被监控标的 ${dup.previousIndex} 和监控标的 ${dup.index} 重复使用。每个交易标的只能被一个监控标的使用。`,
      ];
    }

    errors = [
      ...errors,
      '请检查配置，确保每个 LONG_SYMBOL 和 SHORT_SYMBOL 在所有监控标的中是唯一的。',
    ];
  }

  if (tradingConfig.global.buyOrderTimeout.enabled) {
    const buyOrderTimeoutValidationError = validateCriticalBoundedNumberConfig({
      env,
      envKey: 'BUY_ORDER_TIMEOUT_SECONDS',
      min: 30,
      max: 600,
    });
    if (buyOrderTimeoutValidationError !== null) {
      errors = [...errors, buyOrderTimeoutValidationError];
      missingFields = [...missingFields, 'BUY_ORDER_TIMEOUT_SECONDS'];
    }

    if (
      !Number.isFinite(tradingConfig.global.buyOrderTimeout.timeoutSeconds) ||
      tradingConfig.global.buyOrderTimeout.timeoutSeconds < 30 ||
      tradingConfig.global.buyOrderTimeout.timeoutSeconds > 600
    ) {
      errors = [...errors, 'BUY_ORDER_TIMEOUT_SECONDS 无效（范围 30-600）'];
      missingFields = [...missingFields, 'BUY_ORDER_TIMEOUT_SECONDS'];
    }
  }

  if (tradingConfig.global.sellOrderTimeout.enabled) {
    const sellOrderTimeoutValidationError = validateCriticalBoundedNumberConfig({
      env,
      envKey: 'SELL_ORDER_TIMEOUT_SECONDS',
      min: 30,
      max: 600,
    });
    if (sellOrderTimeoutValidationError !== null) {
      errors = [...errors, sellOrderTimeoutValidationError];
      missingFields = [...missingFields, 'SELL_ORDER_TIMEOUT_SECONDS'];
    }

    if (
      !Number.isFinite(tradingConfig.global.sellOrderTimeout.timeoutSeconds) ||
      tradingConfig.global.sellOrderTimeout.timeoutSeconds < 30 ||
      tradingConfig.global.sellOrderTimeout.timeoutSeconds > 600
    ) {
      errors = [...errors, 'SELL_ORDER_TIMEOUT_SECONDS 无效（范围 30-600）'];
      missingFields = [...missingFields, 'SELL_ORDER_TIMEOUT_SECONDS'];
    }
  }

  const orderMonitorIntervalValidationError = validateCriticalBoundedNumberConfig({
    env,
    envKey: 'ORDER_MONITOR_PRICE_UPDATE_INTERVAL',
    min: 1,
    max: 60,
  });
  if (orderMonitorIntervalValidationError !== null) {
    errors = [...errors, orderMonitorIntervalValidationError];
    missingFields = [...missingFields, 'ORDER_MONITOR_PRICE_UPDATE_INTERVAL'];
  }

  if (
    !Number.isFinite(tradingConfig.global.orderMonitorPriceUpdateInterval) ||
    tradingConfig.global.orderMonitorPriceUpdateInterval < 1 ||
    tradingConfig.global.orderMonitorPriceUpdateInterval > 60
  ) {
    errors = [...errors, 'ORDER_MONITOR_PRICE_UPDATE_INTERVAL 无效（范围 1-60）'];
    missingFields = [...missingFields, 'ORDER_MONITOR_PRICE_UPDATE_INTERVAL'];
  }

  const { morning, afternoon } = tradingConfig.global.openProtection;
  if (morning.enabled) {
    if (morning.minutes === null) {
      errors = [
        ...errors,
        'MORNING_OPENING_PROTECTION_MINUTES 未配置（启用早盘保护时为必填，范围 1-60）',
      ];
      missingFields = [...missingFields, 'MORNING_OPENING_PROTECTION_MINUTES'];
    } else if (morning.minutes < 1 || morning.minutes > 60) {
      errors = [...errors, 'MORNING_OPENING_PROTECTION_MINUTES 无效（范围 1-60）'];
    }
  }

  if (afternoon.enabled) {
    if (afternoon.minutes === null) {
      errors = [
        ...errors,
        'AFTERNOON_OPENING_PROTECTION_MINUTES 未配置（启用午盘保护时为必填，范围 1-60）',
      ];
      missingFields = [...missingFields, 'AFTERNOON_OPENING_PROTECTION_MINUTES'];
    } else if (afternoon.minutes < 1 || afternoon.minutes > 60) {
      errors = [...errors, 'AFTERNOON_OPENING_PROTECTION_MINUTES 无效（范围 1-60）'];
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    missingFields,
  };
}

/**
 * 验证 Longbridge 认证启动配置与多监控交易配置完整性。
 * @param options.env 进程环境变量
 * @param options.tradingConfig 多监控标的交易配置
 * @returns Promise<void>
 */
export async function validateAllConfig({
  env,
  tradingConfig,
}: {
  env: NodeJS.ProcessEnv;
  tradingConfig: MultiMonitorTradingConfig;
}): Promise<void> {
  logger.info('开始验证配置...');

  const longbridgeAuthResult = await Promise.resolve(validateLongbridgeAuthConfig(env));
  const tradingResult = validateTradingConfig(tradingConfig, env);
  const allErrors = [...longbridgeAuthResult.errors, ...tradingResult.errors];
  const allMissingFields = [
    ...new Set([...longbridgeAuthResult.missingFields, ...tradingResult.missingFields]),
  ];

  if (allErrors.length > 0) {
    logger.error('配置验证失败！');
    logger.error('='.repeat(60));
    logger.error('发现以下配置问题：');
    for (const [i, allError] of allErrors.entries()) {
      logger.error(`${i + 1}. ${allError}`);
    }

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

  const currentAuthMode = readAuthMode(env);
  logger.info('配置验证通过，当前配置如下：');
  if (currentAuthMode !== null) {
    logger.info(`Longbridge 认证模式: ${currentAuthMode}`);
  }

  logger.info(`监控标的数量: ${tradingConfig.monitors.length}`);

  for (const monitorConfig of tradingConfig.monitors) {
    const index = monitorConfig.originalIndex;
    const autoSearchEnabled = monitorConfig.autoSearchConfig.autoSearchEnabled;

    logger.info(`\n监控标的 ${index}:`);
    logger.info(`监控标的: ${monitorConfig.monitorSymbol}`);
    logger.info(`订单归属映射: ${monitorConfig.orderOwnershipMapping.join(', ')}`);
    if (autoSearchEnabled) {
      logger.info('自动寻标: 已启用（交易标的由席位动态决定）');
      logger.info(
        `周期换标间隔: ${
          monitorConfig.autoSearchConfig.switchIntervalMinutes > 0
            ? `${monitorConfig.autoSearchConfig.switchIntervalMinutes} 分钟`
            : '已禁用'
        }`,
      );
      logger.info('做多标的: 自动寻标');
      logger.info('做空标的: 自动寻标');
    } else {
      logger.info(`做多标的: ${monitorConfig.longSymbol}`);
      logger.info(`做空标的: ${monitorConfig.shortSymbol}`);
    }

    logger.info(`目标买入金额: ${monitorConfig.targetNotional} HKD`);
    logger.info(`最大持仓市值: ${monitorConfig.maxPositionNotional} HKD`);
    if (monitorConfig.maxUnrealizedLossPerSymbol && monitorConfig.maxUnrealizedLossPerSymbol > 0) {
      logger.info(`单标的浮亏保护阈值: ${monitorConfig.maxUnrealizedLossPerSymbol} HKD`);
    } else {
      logger.info('单标的浮亏保护: 已禁用');
    }

    logger.info(`同方向买入时间间隔: ${monitorConfig.buyIntervalSeconds} 秒`);
    logger.info(
      `保护性清仓后买入冷却: ${formatLiquidationCooldownConfig(monitorConfig.liquidationCooldown)}`,
    );

    if (monitorConfig.liquidationCooldown) {
      logger.info(`止损触发冷却次数: ${monitorConfig.liquidationTriggerLimit}`);
    }

    logger.info(
      `智能平仓超时（第三阶段）: ${
        monitorConfig.smartCloseTimeoutMinutes === null
          ? '已关闭'
          : `${monitorConfig.smartCloseTimeoutMinutes} 分钟`
      }`,
    );

    const verificationConfig = monitorConfig.verificationConfig;
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

    logger.info('信号配置:');
    if (monitorConfig.signalConfig.buycall) {
      logger.info(`BUYCALL: ${formatSignalConfig(monitorConfig.signalConfig.buycall)}`);
    }

    if (monitorConfig.signalConfig.sellcall) {
      logger.info(`SELLCALL: ${formatSignalConfig(monitorConfig.signalConfig.sellcall)}`);
    }

    if (monitorConfig.signalConfig.buyput) {
      logger.info(`BUYPUT: ${formatSignalConfig(monitorConfig.signalConfig.buyput)}`);
    }

    if (monitorConfig.signalConfig.sellput) {
      logger.info(`SELLPUT: ${formatSignalConfig(monitorConfig.signalConfig.sellput)}`);
    }
  }

  logger.info('');
  logger.info(`是否启动末日保护: ${tradingConfig.global.doomsdayProtection ? '是' : '否'}`);
  logger.info(
    `买单跟价允许高于初始委托价: ${
      tradingConfig.global.allowBuyOrderTrackingAboveInitialPrice ? '是' : '否'
    }`,
  );
  logger.info('');
}

/**
 * 根据行情快照批量验证运行时标的有效性。
 * @param options.inputs 待验证的标的列表
 * @param options.quotesMap 标的代码到行情数据的 Map
 * @returns 验证结果
 */
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
    const result = validateSymbolFromQuote(quote, input.symbol, input.label, input.requireLotSize);
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

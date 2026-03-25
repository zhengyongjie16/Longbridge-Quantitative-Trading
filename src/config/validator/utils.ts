import { logger } from '../../utils/logger/index.js';
import { TRADING } from '../../constants/index.js';
import type { LiquidationCooldownConfig, MonitorConfig, NumberRange } from '../../types/config.js';
import type { Quote } from '../../types/quote.js';
import { getStringConfig, isSymbolWithRegion } from '../utils.js';
import { validateLongbridgeConfig } from '../auth/utils.js';
import type {
  DuplicateSymbol,
  SignalConfigKey,
  SymbolValidationContext,
  ValidationResult,
} from './types.js';

const AUTO_SEARCH_DISTANCE_UNIT_HINT =
  'Longbridge warrantList.toCallPrice 原始值会先从小数比值转换为该百分比值口径。';

/**
 * 生成标的代码格式错误提示信息。
 * @param prefix 配置项前缀
 * @param envKey 环境变量键名
 * @param symbol 当前配置的标的代码
 * @returns 格式化错误提示
 */
export function formatSymbolFormatError(prefix: string, envKey: string, symbol: string): string {
  return `${prefix}: ${envKey} 必须使用 ticker.region 格式（如 68711.HK），当前值: ${symbol}`;
}

/**
 * 将清仓冷却配置格式化为可读字符串。
 * @param config 清仓冷却配置
 * @returns 可读描述
 */
export function formatLiquidationCooldownConfig(config: LiquidationCooldownConfig | null): string {
  if (!config) {
    return '未配置（不冷却）';
  }

  if (config.mode === 'minutes') {
    return `${config.minutes} 分钟`;
  }

  return config.mode;
}

/**
 * 验证必填标的代码是否已配置且格式正确。
 * @param context 标的校验上下文
 * @returns 更新后的错误与缺失字段集合
 */
export function validateRequiredSymbol({
  prefix,
  symbol,
  envKey,
  errors,
  missingFields,
}: SymbolValidationContext): Readonly<{
  errors: ReadonlyArray<string>;
  missingFields: ReadonlyArray<string>;
}> {
  if (!symbol || symbol.trim() === '') {
    return {
      errors: [...errors, `${prefix}: ${envKey} 未配置`],
      missingFields: [...missingFields, envKey],
    };
  }

  if (!isSymbolWithRegion(symbol)) {
    return {
      errors: [...errors, formatSymbolFormatError(prefix, envKey, symbol)],
      missingFields,
    };
  }

  return { errors, missingFields };
}

/**
 * 记录交易标的使用情况并检测重复配置。
 * @param symbol 交易标的代码
 * @param index 当前监控标的索引
 * @param tradingSymbols 已出现过的标的映射
 * @param duplicateSymbols 重复记录输出数组
 * @returns void
 */
export function recordTradingSymbolUsage(
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

/**
 * 校验自动寻标降级区间与主阈值的相对关系。
 * @param params 校验参数
 * @returns 错误文案或 null
 */
export function validateDegradedRangeRelationship(params: {
  readonly prefix: string;
  readonly index: number;
  readonly direction: 'LONG' | 'SHORT';
  readonly primaryThreshold: number;
  readonly switchDistanceRange: NumberRange;
}): string | null {
  if (params.direction === 'LONG') {
    if (params.switchDistanceRange.min >= params.primaryThreshold) {
      return (
        `${params.prefix}: SWITCH_DISTANCE_RANGE_BULL_${params.index} 无效（降级区间必须满足 ` +
        `SWITCH_DISTANCE_RANGE_BULL_${params.index}.min < ` +
        `AUTO_SEARCH_MIN_DISTANCE_PCT_BULL_${params.index}，` +
        `运行时单位为百分比值，0.35 表示 0.35%；${AUTO_SEARCH_DISTANCE_UNIT_HINT}）`
      );
    }

    if (params.primaryThreshold >= params.switchDistanceRange.max) {
      return (
        `${params.prefix}: SWITCH_DISTANCE_RANGE_BULL_${params.index} 无效（主阈值必须满足 ` +
        `AUTO_SEARCH_MIN_DISTANCE_PCT_BULL_${params.index} < ` +
        `SWITCH_DISTANCE_RANGE_BULL_${params.index}.max，` +
        `确保自动寻标候选严格位于换标安全区间内部，运行时单位为百分比值，0.35 表示 0.35%；${AUTO_SEARCH_DISTANCE_UNIT_HINT}）`
      );
    }

    return null;
  }

  if (params.switchDistanceRange.min >= params.primaryThreshold) {
    return (
      `${params.prefix}: SWITCH_DISTANCE_RANGE_BEAR_${params.index} 无效（主阈值必须满足 ` +
      `SWITCH_DISTANCE_RANGE_BEAR_${params.index}.min < ` +
      `AUTO_SEARCH_MIN_DISTANCE_PCT_BEAR_${params.index}，` +
      `确保自动寻标候选严格位于换标安全区间内部，运行时单位为百分比值，-0.35 表示 -0.35%；${AUTO_SEARCH_DISTANCE_UNIT_HINT}）`
    );
  }

  if (params.primaryThreshold >= params.switchDistanceRange.max) {
    return (
      `${params.prefix}: SWITCH_DISTANCE_RANGE_BEAR_${params.index} 无效（降级区间必须满足 ` +
      `AUTO_SEARCH_MIN_DISTANCE_PCT_BEAR_${params.index} < ` +
      `SWITCH_DISTANCE_RANGE_BEAR_${params.index}.max，` +
      `运行时单位为百分比值，-0.35 表示 -0.35%；${AUTO_SEARCH_DISTANCE_UNIT_HINT}）`
    );
  }

  return null;
}

/**
 * 验证 Longbridge 认证启动配置是否已配置且合法。
 * @param env 进程环境变量
 * @returns 验证结果
 */
export function validateLongbridgeAuthConfig(env: NodeJS.ProcessEnv): ValidationResult {
  const issues = validateLongbridgeConfig(env);

  return {
    valid: issues.length === 0,
    errors: issues.map((issue) => issue.message),
    missingFields: issues.map((issue) => issue.envKey),
  };
}

/**
 * 校验显式配置的关键数值是否是指定范围内的有限数字。
 * @param options 校验参数
 * @returns 缺失时返回 null；显式配置但非法时返回错误信息
 */
export function validateCriticalBoundedNumberConfig({
  env,
  envKey,
  min,
  max,
}: {
  readonly env: NodeJS.ProcessEnv;
  readonly envKey: string;
  readonly min: number;
  readonly max: number;
}): string | null {
  const raw = env[envKey];
  if (raw === undefined || raw.trim() === '') {
    return null;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    return `${envKey} 无效（必须为数字，范围 ${min}-${max}）`;
  }

  return null;
}

/**
 * 校验显式配置的关键数值是否是大于等于下限的有限数字。
 * @param options 校验参数
 * @returns 缺失时返回 null；显式配置但非法时返回错误信息
 */
export function validateCriticalMinimumNumberConfig({
  env,
  envKey,
  min,
}: {
  readonly env: NodeJS.ProcessEnv;
  readonly envKey: string;
  readonly min: number;
}): string | null {
  const raw = env[envKey];
  if (raw === undefined || raw.trim() === '') {
    return null;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    return `${envKey} 无效（必须为数字且 >= ${min}）`;
  }

  return null;
}

/**
 * 校验监控标的索引是否连续。
 * @param env 进程环境变量
 * @returns 索引连续性校验结果
 */
export function validateMonitorSymbolIndexContinuity(env: NodeJS.ProcessEnv): Readonly<{
  errors: ReadonlyArray<string>;
  missingFields: ReadonlyArray<string>;
}> {
  const configuredMonitorIndexes: number[] = [];

  for (let i = 1; i <= TRADING.MAX_MONITOR_SCAN_RANGE; i++) {
    const monitorSymbol = getStringConfig(env, `MONITOR_SYMBOL_${i}`);
    if (!monitorSymbol) {
      continue;
    }

    configuredMonitorIndexes.push(i);
  }

  if (configuredMonitorIndexes.length === 0) {
    return {
      errors: [],
      missingFields: [],
    };
  }

  const highestConfiguredIndex = configuredMonitorIndexes.at(-1) ?? 0;
  const configuredMonitorSet = new Set(configuredMonitorIndexes);
  const errors: string[] = [];
  const missingFields: string[] = [];

  for (let i = 1; i <= highestConfiguredIndex; i++) {
    if (configuredMonitorSet.has(i)) {
      continue;
    }

    const missingKey = `MONITOR_SYMBOL_${i}`;
    errors.push(`${missingKey} 未配置（监控标的索引必须连续，不允许断档）`);
    missingFields.push(missingKey);
  }

  return {
    errors,
    missingFields,
  };
}

/**
 * 从行情数据验证标的有效性。
 * @param quote 标的行情数据
 * @param symbol 标的代码
 * @param symbolLabel 用于错误信息的标签
 * @param requireLotSize 是否要求 lotSize
 * @returns 验证结果
 */
export function validateSymbolFromQuote(
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

  if (!quote.name) {
    logger.warn(`${symbolLabel} ${symbol} 缺少中文名称信息`);
  }

  if (requireLotSize && (quote.lotSize === undefined || quote.lotSize <= 0)) {
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

/**
 * 验证单个监控标的的配置完整性。
 * @param config 监控标的配置
 * @param index 监控标的索引
 * @param env 进程环境变量
 * @returns 监控标的验证结果
 */
export function validateMonitorConfig(
  config: MonitorConfig,
  index: number,
  env: NodeJS.ProcessEnv,
): ValidationResult {
  let errors: ReadonlyArray<string> = [];
  let missingFields: ReadonlyArray<string> = [];
  const prefix = `监控标的 ${index}`;

  const result1 = validateRequiredSymbol({
    prefix,
    symbol: config.monitorSymbol,
    envKey: `MONITOR_SYMBOL_${index}`,
    errors,
    missingFields,
  });
  errors = result1.errors;
  missingFields = result1.missingFields;

  const autoSearchEnabled = config.autoSearchConfig.autoSearchEnabled;

  if (config.orderOwnershipMapping.length === 0) {
    const mappingKey = `ORDER_OWNERSHIP_MAPPING_${index}`;
    errors = [...errors, `${prefix}: ${mappingKey} 未配置或为空（用于 stockName 归属解析）`];
    missingFields = [...missingFields, mappingKey];
  }

  if (!autoSearchEnabled) {
    const result2 = validateRequiredSymbol({
      prefix,
      symbol: config.longSymbol,
      envKey: `LONG_SYMBOL_${index}`,
      errors,
      missingFields,
    });
    errors = result2.errors;
    missingFields = result2.missingFields;

    const result3 = validateRequiredSymbol({
      prefix,
      symbol: config.shortSymbol,
      envKey: `SHORT_SYMBOL_${index}`,
      errors,
      missingFields,
    });
    errors = result3.errors;
    missingFields = result3.missingFields;
  }

  const targetNotionalEnvKey = `TARGET_NOTIONAL_${index}`;
  const targetNotionalValidationError = validateCriticalMinimumNumberConfig({
    env,
    envKey: targetNotionalEnvKey,
    min: 1,
  });
  if (targetNotionalValidationError !== null) {
    errors = [...errors, `${prefix}: ${targetNotionalValidationError}`];
    missingFields = [...missingFields, targetNotionalEnvKey];
  }

  if (!Number.isFinite(config.targetNotional) || config.targetNotional <= 0) {
    errors = [...errors, `${prefix}: ${targetNotionalEnvKey} 未配置或无效（必须为正数）`];
    missingFields = [...missingFields, targetNotionalEnvKey];
  }

  const maxPositionNotionalEnvKey = `MAX_POSITION_NOTIONAL_${index}`;
  const maxPositionNotionalValidationError = validateCriticalMinimumNumberConfig({
    env,
    envKey: maxPositionNotionalEnvKey,
    min: 1,
  });
  if (maxPositionNotionalValidationError !== null) {
    errors = [...errors, `${prefix}: ${maxPositionNotionalValidationError}`];
    missingFields = [...missingFields, maxPositionNotionalEnvKey];
  }

  if (!Number.isFinite(config.maxPositionNotional) || config.maxPositionNotional <= 0) {
    errors = [...errors, `${prefix}: ${maxPositionNotionalEnvKey} 未配置或无效（必须为正数）`];
    missingFields = [...missingFields, maxPositionNotionalEnvKey];
  }

  const buyIntervalEnvKey = `BUY_INTERVAL_SECONDS_${index}`;
  const buyIntervalValidationError = validateCriticalBoundedNumberConfig({
    env,
    envKey: buyIntervalEnvKey,
    min: 10,
    max: 600,
  });
  if (buyIntervalValidationError !== null) {
    errors = [...errors, `${prefix}: ${buyIntervalValidationError}`];
    missingFields = [...missingFields, buyIntervalEnvKey];
  }

  if (
    !Number.isFinite(config.buyIntervalSeconds) ||
    config.buyIntervalSeconds < 10 ||
    config.buyIntervalSeconds > 600
  ) {
    errors = [...errors, `${prefix}: ${buyIntervalEnvKey} 无效（范围 10-600）`];
    missingFields = [...missingFields, buyIntervalEnvKey];
  }

  const liquidationCooldownEnvKey = `LIQUIDATION_COOLDOWN_MINUTES_${index}`;
  const configuredCooldown = getStringConfig(env, liquidationCooldownEnvKey);
  const isCooldownParsingFailed = Boolean(configuredCooldown) && !config.liquidationCooldown;
  const isMinutesOutOfRange =
    config.liquidationCooldown?.mode === 'minutes' &&
    (!Number.isFinite(config.liquidationCooldown.minutes) ||
      config.liquidationCooldown.minutes < 1 ||
      config.liquidationCooldown.minutes > 120);
  if (isCooldownParsingFailed || isMinutesOutOfRange) {
    errors = [
      ...errors,
      `${prefix}: ${liquidationCooldownEnvKey} 无效（范围 1-120 或 half-day / one-day）`,
    ];
  }

  if (config.liquidationCooldown) {
    const triggerLimit = config.liquidationTriggerLimit;
    if (!Number.isInteger(triggerLimit) || triggerLimit < 1 || triggerLimit > 10) {
      const triggerLimitEnvKey = `LIQUIDATION_TRIGGER_LIMIT_${index}`;
      errors = [...errors, `${prefix}: ${triggerLimitEnvKey} 无效（范围 1-10）`];
      missingFields = [...missingFields, triggerLimitEnvKey];
    }
  }

  const smartCloseTimeoutEnvKey = `SMART_CLOSE_TIMEOUT_MINUTES_${index}`;
  const smartCloseTimeoutRaw = env[smartCloseTimeoutEnvKey];
  if (smartCloseTimeoutRaw !== undefined) {
    const trimmed = smartCloseTimeoutRaw.trim();
    const isDisabledValue = trimmed === '' || trimmed.toLowerCase() === 'null';
    if (!isDisabledValue) {
      const parsed = Number(trimmed);
      if (!Number.isInteger(parsed) || parsed < 0) {
        errors = [
          ...errors,
          `${prefix}: ${smartCloseTimeoutEnvKey} 无效（必须为非负整数或留空/null）`,
        ];
        missingFields = [...missingFields, smartCloseTimeoutEnvKey];
      }
    }
  }

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
      errors = [...errors, `${prefix}: ${envName} 未配置或解析失败（信号配置为必需项）`];
      missingFields = [...missingFields, envName];
    }
  }

  if (autoSearchEnabled) {
    const autoSearchConfig = config.autoSearchConfig;
    const switchIntervalEnvKey = `SWITCH_INTERVAL_MINUTES_${index}`;
    const requiredNumberFields = [
      {
        value: autoSearchConfig.autoSearchMinDistancePctBull,
        envKey: `AUTO_SEARCH_MIN_DISTANCE_PCT_BULL_${index}`,
      },
      {
        value: autoSearchConfig.autoSearchMinDistancePctBear,
        envKey: `AUTO_SEARCH_MIN_DISTANCE_PCT_BEAR_${index}`,
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
        errors = [...errors, `${prefix}: ${field.envKey} 未配置或无效`];
        missingFields = [...missingFields, field.envKey];
      }
    }

    if (
      !Number.isFinite(autoSearchConfig.autoSearchExpiryMinMonths) ||
      autoSearchConfig.autoSearchExpiryMinMonths < 1
    ) {
      errors = [...errors, `${prefix}: AUTO_SEARCH_EXPIRY_MIN_MONTHS_${index} 无效（必须 >= 1）`];
      missingFields = [...missingFields, `AUTO_SEARCH_EXPIRY_MIN_MONTHS_${index}`];
    }

    if (
      !Number.isFinite(autoSearchConfig.autoSearchOpenDelayMinutes) ||
      autoSearchConfig.autoSearchOpenDelayMinutes < 0
    ) {
      errors = [...errors, `${prefix}: AUTO_SEARCH_OPEN_DELAY_MINUTES_${index} 无效（必须 >= 0）`];
      missingFields = [...missingFields, `AUTO_SEARCH_OPEN_DELAY_MINUTES_${index}`];
    }

    const switchIntervalValidationError = validateCriticalBoundedNumberConfig({
      env,
      envKey: switchIntervalEnvKey,
      min: 0,
      max: 120,
    });
    if (switchIntervalValidationError !== null) {
      errors = [...errors, `${prefix}: ${switchIntervalValidationError}`];
      missingFields = [...missingFields, switchIntervalEnvKey];
    }

    if (
      !Number.isFinite(autoSearchConfig.switchIntervalMinutes) ||
      autoSearchConfig.switchIntervalMinutes < 0 ||
      autoSearchConfig.switchIntervalMinutes > 120
    ) {
      errors = [...errors, `${prefix}: ${switchIntervalEnvKey} 无效（范围 0-120）`];
      missingFields = [...missingFields, switchIntervalEnvKey];
    }

    const bullRange = autoSearchConfig.switchDistanceRangeBull;
    if (
      !bullRange ||
      !Number.isFinite(bullRange.min) ||
      !Number.isFinite(bullRange.max) ||
      bullRange.min > bullRange.max
    ) {
      errors = [
        ...errors,
        `${prefix}: SWITCH_DISTANCE_RANGE_BULL_${index} 未配置或无效（格式 min,max 且 min<=max）`,
      ];
      missingFields = [...missingFields, `SWITCH_DISTANCE_RANGE_BULL_${index}`];
    } else if (
      autoSearchConfig.autoSearchMinDistancePctBull !== null &&
      Number.isFinite(autoSearchConfig.autoSearchMinDistancePctBull)
    ) {
      const bullRangeRelationshipError = validateDegradedRangeRelationship({
        prefix,
        index,
        direction: 'LONG',
        primaryThreshold: autoSearchConfig.autoSearchMinDistancePctBull,
        switchDistanceRange: bullRange,
      });
      if (bullRangeRelationshipError !== null) {
        errors = [...errors, bullRangeRelationshipError];
      }
    }

    const bearRange = autoSearchConfig.switchDistanceRangeBear;
    if (
      !bearRange ||
      !Number.isFinite(bearRange.min) ||
      !Number.isFinite(bearRange.max) ||
      bearRange.min > bearRange.max
    ) {
      errors = [
        ...errors,
        `${prefix}: SWITCH_DISTANCE_RANGE_BEAR_${index} 未配置或无效（格式 min,max 且 min<=max）`,
      ];
      missingFields = [...missingFields, `SWITCH_DISTANCE_RANGE_BEAR_${index}`];
    } else if (
      autoSearchConfig.autoSearchMinDistancePctBear !== null &&
      Number.isFinite(autoSearchConfig.autoSearchMinDistancePctBear)
    ) {
      const bearRangeRelationshipError = validateDegradedRangeRelationship({
        prefix,
        index,
        direction: 'SHORT',
        primaryThreshold: autoSearchConfig.autoSearchMinDistancePctBear,
        switchDistanceRange: bearRange,
      });
      if (bearRangeRelationshipError !== null) {
        errors = [...errors, bearRangeRelationshipError];
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    missingFields,
  };
}

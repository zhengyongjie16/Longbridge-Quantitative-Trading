import type { MonitorConfig } from '../types/config.js';

/** LongPort API 区域端点 URL，由 getRegionUrls 根据区域返回，仅 config 模块内部使用 */
export type RegionUrls = {
  readonly httpUrl: string;
  readonly quoteWsUrl: string;
  readonly tradeWsUrl: string;
};

/**
 * 配置验证错误（含缺失字段列表）
 * 用途：封装配置验证失败时的错误信息
 * 数据来源：由配置验证函数（validateLongPortConfig / validateTradingConfig）抛出
 * 使用范围：仅在 config 模块内部使用
 */
export type ConfigValidationError = Error & {
  readonly name: 'ConfigValidationError';
  readonly missingFields: ReadonlyArray<string>;
};

/** parseBoundedNumberConfig 的参数包，封装带上下限的数值配置读取所需字段，仅 config 模块内部使用 */
export type BoundedNumberConfig = {
  readonly env: NodeJS.ProcessEnv;
  readonly envKey: string;
  readonly defaultValue: number;
  readonly min: number;
  readonly max: number;
};

/**
 * 通用验证结果
 * 用途：描述配置验证的通过/失败状态及错误列表
 * 数据来源：由 validateLongPortConfig / validateTradingConfig 返回
 * 使用范围：仅在 config 模块内部使用
 */
export type ValidationResult = {
  readonly valid: boolean;
  readonly errors: ReadonlyArray<string>;
};

/**
 * 交易配置验证结果（含缺失字段列表）
 * 用途：扩展 ValidationResult，额外包含缺失字段列表
 * 数据来源：由 validateTradingConfig 返回
 * 使用范围：仅在 config 模块内部使用
 */
export type TradingValidationResult = ValidationResult & {
  readonly missingFields: ReadonlyArray<string>;
};

/** validateRequiredSymbol 的参数包，传递标的验证所需上下文，仅 config 模块内部使用 */
export type SymbolValidationContext = {
  readonly prefix: string;
  readonly symbol: string;
  readonly envKey: string;
  readonly errors: ReadonlyArray<string>;
  readonly missingFields: ReadonlyArray<string>;
};

/** 重复交易标的记录，由 validateTradingConfig 检测并收集，仅 config 模块内部使用 */
export type DuplicateSymbol = {
  readonly symbol: string;
  readonly index: number;
  readonly previousIndex: number;
};

/** validateRuntimeSymbolsFromQuotesMap 的单条输入，描述待验证标的及其验证要求，仅 config 模块内部使用 */
export type RuntimeSymbolValidationInput = {
  readonly symbol: string;
  readonly label: string;
  readonly requireLotSize: boolean;
  readonly required: boolean;
};

/** validateRuntimeSymbolsFromQuotesMap 的返回结果，区分硬错误与警告，仅 config 模块内部使用 */
export type RuntimeSymbolValidationResult = {
  readonly valid: boolean;
  readonly errors: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
};

/** MonitorConfig 信号配置的键名联合类型，用于遍历信号配置项，仅 config 模块内部使用 */
export type SignalConfigKey = keyof MonitorConfig['signalConfig'];


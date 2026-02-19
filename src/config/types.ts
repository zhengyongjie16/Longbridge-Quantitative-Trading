import type { MonitorConfig } from '../types/config.js';

/**
 * LongPort API 区域端点 URL。
 * 类型用途：封装 HTTP、行情 WebSocket、交易 WebSocket 的 base URL，作为 getRegionUrls 返回类型及 LongPort 初始化入参。
 * 数据来源：getRegionUrls 根据区域返回。
 * 使用范围：仅 config 模块内部使用。
 */
export type RegionUrls = {
  readonly httpUrl: string;
  readonly quoteWsUrl: string;
  readonly tradeWsUrl: string;
};

/**
 * 配置验证错误（含缺失字段列表）。
 * 类型用途：封装配置验证失败时的错误信息，作为验证函数抛出的错误类型。
 * 数据来源：由 validateLongPortConfig / validateTradingConfig 抛出。
 * 使用范围：仅 config 模块内部使用。
 */
export type ConfigValidationError = Error & {
  readonly name: 'ConfigValidationError';
  readonly missingFields: ReadonlyArray<string>;
};

/**
 * 带上下限的数值配置读取参数。
 * 类型用途：作为 parseBoundedNumberConfig 的入参，从环境变量读取并校验范围内的数值。
 * 数据来源：调用方从 process.env 及配置键传入。
 * 使用范围：仅 config 模块内部使用。
 */
export type BoundedNumberConfig = {
  readonly env: NodeJS.ProcessEnv;
  readonly envKey: string;
  readonly defaultValue: number;
  readonly min: number;
  readonly max: number;
};

/**
 * 通用验证结果。
 * 类型用途：描述配置验证的通过/失败状态及错误列表，作为验证函数的返回类型。
 * 数据来源：由 validateLongPortConfig / validateTradingConfig 返回。
 * 使用范围：仅 config 模块内部使用。
 */
export type ValidationResult = {
  readonly valid: boolean;
  readonly errors: ReadonlyArray<string>;
};

/**
 * 交易配置验证结果（含缺失字段列表）。
 * 类型用途：扩展 ValidationResult，额外包含缺失字段列表，作为 validateTradingConfig 的返回类型。
 * 数据来源：由 validateTradingConfig 返回。
 * 使用范围：仅 config 模块内部使用。
 */
export type TradingValidationResult = ValidationResult & {
  readonly missingFields: ReadonlyArray<string>;
};

/**
 * 标的校验上下文。
 * 类型用途：作为 validateRequiredSymbol 的入参/上下文，累积错误与缺失字段。
 * 使用范围：仅 config 模块内部使用。
 */
export type SymbolValidationContext = {
  readonly prefix: string;
  readonly symbol: string;
  readonly envKey: string;
  readonly errors: ReadonlyArray<string>;
  readonly missingFields: ReadonlyArray<string>;
};

/**
 * 重复交易标的记录。
 * 类型用途：表示配置中重复出现的交易标的及其索引，供校验错误报告使用。
 * 数据来源：由 validateTradingConfig 检测并收集。
 * 使用范围：仅 config 模块内部使用。
 */
export type DuplicateSymbol = {
  readonly symbol: string;
  readonly index: number;
  readonly previousIndex: number;
};

/**
 * 运行时标的校验单条输入。
 * 类型用途：作为 validateRuntimeSymbolsFromQuotesMap 的单条校验项入参。
 * 使用范围：仅 config 模块内部使用。
 */
export type RuntimeSymbolValidationInput = {
  readonly symbol: string;
  readonly label: string;
  readonly requireLotSize: boolean;
  readonly required: boolean;
};

/**
 * 运行时标的校验结果。
 * 类型用途：表示单次运行时标的校验的通过状态及错误/警告列表，作为 validateRuntimeSymbolsFromQuotesMap 的返回类型。
 * 数据来源：由 validateRuntimeSymbolsFromQuotesMap 返回。
 * 使用范围：仅 config 模块内部使用。
 */
export type RuntimeSymbolValidationResult = {
  readonly valid: boolean;
  readonly errors: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
};

/**
 * 信号配置键名联合类型。
 * 类型用途：表示 MonitorConfig.signalConfig 的键名（buycall/sellcall/buyput/sellput），用于遍历信号配置项。
 * 使用范围：仅 config 模块内部使用。
 */
export type SignalConfigKey = keyof MonitorConfig['signalConfig'];


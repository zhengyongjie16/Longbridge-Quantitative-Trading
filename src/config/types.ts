/**
 * 配置验证错误（含缺失或非法字段列表）。
 * 类型用途：封装配置解析/聚合校验失败时抛出的错误对象类型。
 * 数据来源：由 createConfigValidationError 构造，并在 fail-fast 解析路径与 validateAllConfig 聚合校验路径抛出。
 * 使用范围：供 config 模块及其调用方识别配置错误使用。
 */
export type ConfigValidationError = Error & {
  readonly name: 'ConfigValidationError';
  readonly missingFields: ReadonlyArray<string>;
};

/**
 * 运行时标的校验单条输入。
 * 类型用途：作为 validateRuntimeSymbolsFromQuotesMap 的单条校验项入参。
 * 数据来源：由运行时标的列表与校验策略映射后构造。
 * 使用范围：供 config validator 与 app 装配层共同消费的公共类型边界。
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
 * 使用范围：供 config validator 与 app 装配层共同消费的公共类型边界。
 */
export type RuntimeSymbolValidationResult = {
  readonly valid: boolean;
  readonly errors: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
};

/**
 * 比较运算符。
 * 类型用途：约束信号条件中允许的比较符，仅支持 `<` 与 `>`。
 * 数据来源：来自信号条件字符串语法定义。
 * 使用范围：仅 config 模块内部解析与校验流程使用。
 */
export type ComparisonOperator = '<' | '>';

/**
 * 解析后的单条条件。
 * 类型用途：表示从信号配置字符串中解析出的单个指标比较条件。
 * 数据来源：由 parseCondition 解析配置字符串得到。
 * 使用范围：仅 config 模块内部 signalConfig 解析流程使用。
 */
export type ParsedCondition = {
  readonly indicator: string;
  readonly period?: number;
  readonly operator: ComparisonOperator;
  readonly threshold: number;
};

/**
 * 解析后的条件组。
 * 类型用途：表示一组条件及其最少满足数量，用于信号配置解析结果的中间表达。
 * 数据来源：由 parseConditionGroup 解析配置字符串得到。
 * 使用范围：仅 config 模块内部 signalConfig 解析流程使用。
 */
export type ParsedConditionGroup = {
  readonly conditions: ReadonlyArray<ParsedCondition>;
  readonly minSatisfied: number;
};

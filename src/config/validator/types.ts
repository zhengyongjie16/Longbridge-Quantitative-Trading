import type { MonitorConfig } from '../../types/config.js';

/**
 * 通用配置校验结果。
 * 类型用途：表达配置校验是否通过，以及累积的错误与缺失或非法字段列表。
 * 数据来源：由 validator 模块内部各类 validate 函数返回。
 * 使用范围：仅 validator 模块内部使用。
 */
export type ValidationResult = {
  readonly valid: boolean;
  readonly errors: ReadonlyArray<string>;
  readonly missingFields: ReadonlyArray<string>;
};

/**
 * 标的校验上下文。
 * 类型用途：作为 validateRequiredSymbol 的入参，累积错误与缺失字段。
 * 数据来源：由 validator 聚合流程构造。
 * 使用范围：仅 validator 模块内部使用。
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
 * 类型用途：表示重复出现的交易标的及其原始索引。
 * 数据来源：由 duplicate symbol 检测流程收集。
 * 使用范围：仅 validator 模块内部使用。
 */
export type DuplicateSymbol = {
  readonly symbol: string;
  readonly index: number;
  readonly previousIndex: number;
};

/**
 * 信号配置键名联合类型。
 * 类型用途：表示 MonitorConfig.signalConfig 的固定四个键。
 * 数据来源：派生自 MonitorConfig 的 signalConfig 字段键名。
 * 使用范围：仅 validator 模块内部使用。
 */
export type SignalConfigKey = keyof MonitorConfig['signalConfig'];

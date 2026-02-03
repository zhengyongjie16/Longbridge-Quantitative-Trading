/**
 * 辅助函数类型定义模块
 *
 * 定义辅助函数相关的类型：
 * - DecimalLike：LongPort Decimal 兼容接口
 * - TimeFormatOptions：时间格式化选项
 * - QuoteDisplayResult：行情显示格式化结果
 * - IndicatorState：指标状态接口（KDJ、MACD、EMA、RSI、PSY、MFI）
 * - ParsedCondition / ParsedConditionGroup：信号配置解析结果
 * - EvaluationResult / ConditionGroupResult：条件评估结果
 * - HKTime：香港时间结构
 */

/** LongPort Decimal 类型兼容接口 */
export type DecimalLike = {
  toNumber(): number;
};

/**
 * 时间格式化选项（内部使用）
 */
export type TimeFormatOptions = {
  readonly format?: 'iso' | 'log';
};

/**
 * 行情显示格式化结果
 */
export type QuoteDisplayResult = {
  readonly nameText: string;
  readonly codeText: string;
  readonly priceText: string;
  readonly changeAmountText: string;
  readonly changePercentText: string;
};

/**
 * 指标状态接口（用于获取指标值）
 */
export type IndicatorState = {
  readonly ema?: Record<number, number> | null;
  readonly rsi?: Record<number, number> | null;
  readonly psy?: Record<number, number> | null;
  readonly mfi?: number | null;
  readonly kdj?: { readonly k?: number; readonly d?: number; readonly j?: number } | null;
  readonly macd?: { readonly macd?: number; readonly dif?: number; readonly dea?: number } | null;
};

// ============= signalConfigParser 类型定义 =============

/**
 * 解析后的条件（带可选周期）
 */
export type ParsedCondition = {
  readonly indicator: string;
  readonly period?: number;
  readonly operator: '<' | '>';
  readonly threshold: number;
};

/**
 * 解析后的条件组
 */
export type ParsedConditionGroup = {
  readonly conditions: ReadonlyArray<ParsedCondition>;
  readonly minSatisfied: number;
};

/**
 * 评估结果接口
 */
export type EvaluationResult = {
  readonly triggered: boolean;
  readonly satisfiedGroupIndex: number;
  readonly satisfiedCount: number;
  readonly reason: string;
};

/**
 * 条件组评估结果接口
 */
export type ConditionGroupResult = {
  readonly satisfied: boolean;
  readonly count: number;
};

// ============= tradingTime 类型定义 =============

/**
 * 香港时间结构
 */
export type HKTime = {
  readonly hkHour: number;
  readonly hkMinute: number;
};

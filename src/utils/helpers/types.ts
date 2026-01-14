/**
 * 工具函数模块类型定义
 */

/**
 * LongPort Decimal 类型接口
 */
export type DecimalLike = {
  toNumber(): number;
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

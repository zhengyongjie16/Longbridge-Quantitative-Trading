/**
 * 信号配置解析模块类型定义
 */

// 从共享类型导入 SignalConfig（不重复导出，使用方应直接导入）
import type { SignalConfig } from '../../types/index.js';

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
 * 信号配置验证结果接口
 */
export type SignalValidationResult = {
  readonly valid: boolean;
  readonly error: string | null;
  readonly config: SignalConfig | null;
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

/**
 * @module types/signalConfig
 * @description 信号配置类型定义
 *
 * 定义信号触发条件和配置相关的类型
 */

/**
 * 信号触发条件
 * 定义单个指标的触发规则
 */
export type Condition = {
  /** 指标名称（如 rsi_14, kdj_k） */
  readonly indicator: string;
  /** 比较运算符 */
  readonly operator: '<' | '>';
  /** 阈值 */
  readonly threshold: number;
};

/**
 * 条件组
 * 包含一组条件和满足数量要求
 */
export type ConditionGroup = {
  /** 条件列表 */
  readonly conditions: ReadonlyArray<Condition>;
  /** 需满足的条件数量（null 表示全部满足） */
  readonly requiredCount: number | null;
};

/**
 * 信号配置
 * 定义触发某种信号所需的条件组合
 */
export type SignalConfig = {
  /** 条件组列表（组间为 AND 关系） */
  readonly conditionGroups: ReadonlyArray<ConditionGroup>;
};

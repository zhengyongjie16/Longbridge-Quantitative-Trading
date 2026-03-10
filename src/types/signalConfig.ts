/**
 * 信号触发条件。
 * 类型用途：单条指标的触发规则（指标名、比较符、阈值），作为 ConditionGroup.conditions 元素类型。
 * 数据来源：配置解析（MonitorConfig.signalConfig）。
 * 使用范围：信号配置解析与条件评估；全项目可引用。
 */
export type Condition = {
  /** 指标名称（如 "RSI:6"、"PSY:12"、"MFI"、"K"、"D"、"J"） */
  readonly indicator: string;

  /** 比较运算符 */
  readonly operator: '<' | '>';

  /** 阈值 */
  readonly threshold: number;
};

/**
 * 条件组。
 * 类型用途：一组条件及需满足的数量要求，作为 SignalConfig.conditionGroups 元素类型；组内为"满足 N 项"，组间为 OR（满足任一组即可触发）。
 * 数据来源：配置解析（MonitorConfig.signalConfig）。
 * 使用范围：信号配置解析与条件评估；全项目可引用。
 */
export type ConditionGroup = {
  /** 条件列表 */
  readonly conditions: ReadonlyArray<Condition>;

  /** 需满足的条件数量（null 表示全部满足） */
  readonly requiredCount: number | null;
};

/**
 * 信号配置。
 * 类型用途：单类信号（买多/卖多/买空/卖空）的触发条件组合，作为 SignalConfigSet 各键的类型。
 * 数据来源：配置解析（MonitorConfig.signalConfig）。
 * 使用范围：策略、信号条件评估等；全项目可引用。
 */
export type SignalConfig = {
  /** 条件组列表（组间为 OR 关系，满足任一组即触发） */
  readonly conditionGroups: ReadonlyArray<ConditionGroup>;
};

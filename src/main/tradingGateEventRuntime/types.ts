import type { Unsubscribe } from '../../types/services.js';

/**
 * 连续交易门禁变化事件。
 * 类型用途：把现有时间控制平面的 canTrade 状态变化显式事件化，供非周期自动寻标 runtime 消费。
 * 数据来源：timeWakeupEvaluationProgram 在计算并写入 lastState.canTrade 后发布。
 * 使用范围：AutoSearchWakeupRuntime、PeriodicSwitchWakeupRuntime 与 app runtime 接线。
 */
export type TradingGateStateChangedEvent = Readonly<{
  previousCanTrade: boolean | null;
  nextCanTrade: boolean;
  timestampMs: number;
}>;

/**
 * 连续交易门禁事件端口。
 * 类型用途：提供 gate state 变化的订阅与发布能力。
 * 数据来源：由 createTradingGateEventRuntime 创建。
 * 使用范围：app runtime 装配、timeWakeupEvaluationProgram、AutoSearchWakeupRuntime 与 PeriodicSwitchWakeupRuntime。
 */
export interface TradingGateEventRuntime {
  readonly emitGateStateChanged: (event: TradingGateStateChangedEvent) => void;
  readonly onGateStateChanged: (
    listener: (event: TradingGateStateChangedEvent) => void,
  ) => Unsubscribe;
}

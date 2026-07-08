import type { MultiMonitorTradingConfig } from '../../types/config.js';
import type { LastState, MonitorContext } from '../../types/state.js';
import type { SymbolRegistry } from '../../types/seat.js';
import type { TradingGateEventRuntime } from '../tradingGateEventRuntime/types.js';

/**
 * 自动寻标 route key。
 * 类型用途：以 monitorSymbol + direction + seatVersion 唯一标识一条空席位寻标唤醒链。
 * 数据来源：由 AutoSearchWakeupRuntime 在安排 one-shot timer 时构造。
 * 使用范围：仅 AutoSearchWakeupRuntime 模块内部使用。
 */
export type AutoSearchRouteKey = `${string}:${'LONG' | 'SHORT'}:${number}`;

/**
 * 自动寻标 runtime 依赖。
 * 类型用途：创建运行时空席位自动寻标事件 owner 所需的权威状态与 timer 能力。
 * 数据来源：app runtime 装配层。
 * 使用范围：AutoSearchWakeupRuntime 工厂。
 */
export type AutoSearchWakeupRuntimeDeps = Readonly<{
  tradingConfig: MultiMonitorTradingConfig;
  symbolRegistry: SymbolRegistry;
  monitorContexts: ReadonlyMap<string, MonitorContext>;
  lastState: Pick<LastState, 'canTrade' | 'isTradingEnabled'>;
  tradingGateEventRuntime: Pick<TradingGateEventRuntime, 'onGateStateChanged'>;
  now: () => Date;
  scheduleTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
}>;

/**
 * 自动寻标 wakeup runtime。
 * 类型用途：运行期空席位自动寻标的唯一事件 owner。
 * 数据来源：由 createAutoSearchWakeupRuntime 创建。
 * 使用范围：app 装配、lifecycle 与 cleanup。
 */
export interface AutoSearchWakeupRuntime {
  readonly start: () => void;
  readonly stopAndDrain: () => Promise<void>;
  readonly drainFatalError: () => Promise<never>;
}

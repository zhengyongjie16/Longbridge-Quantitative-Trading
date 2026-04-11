import type { MultiMonitorTradingConfig } from '../../types/config.js';
import type { LastState, MonitorContext } from '../../types/state.js';
import type { SymbolRegistry } from '../../types/seat.js';
import type { TradingGateEventRuntime } from '../tradingGateEventRuntime/types.js';

/**
 * 自动寻标唤醒来源。
 * 类型用途：标记本次 AutoSearchWakeupRuntime 重新评估空席位的触发因子。
 * 数据来源：seat event、gate event 或 one-shot timer。
 * 使用范围：AutoSearchWakeupRuntime 内部日志与测试。
 */
export type AutoSearchWakeupKind =
  | 'SEAT_EMPTY'
  | 'GATE_OPEN'
  | 'SEARCH_COOLDOWN_TIMER'
  | 'OPEN_DELAY_TIMER'
  | 'START_SEED';

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
}

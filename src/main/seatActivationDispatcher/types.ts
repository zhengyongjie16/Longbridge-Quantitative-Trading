import type { MultiMonitorTradingConfig } from '../../types/config.js';
import type { SymbolRegistry } from '../../types/seat.js';
import type { MonitorTaskDataMap } from '../asyncProgram/monitorTaskProcessor/types.js';
import type { MonitorTaskQueue } from '../asyncProgram/monitorTaskQueue/types.js';

/**
 * 席位激活 route key。
 * 类型用途：以 monitorSymbol + direction 记录 SWITCHING 到 ACTIVATING 之间的旧标的缓存。
 * 数据来源：SeatActivationDispatcher 监听 seat 状态事件时构造。
 * 使用范围：仅 SeatActivationDispatcher 模块内部使用。
 */
export type SeatActivationRouteKey = `${string}:${'LONG' | 'SHORT'}`;

/**
 * 待激活席位缓存。
 * 类型用途：暂存 SWITCHING 事件中的旧标的与版本，用于后续 ACTIVATING 调度 SEAT_REFRESH。
 * 数据来源：SymbolRegistry 的 SeatStateChangedEvent。
 * 使用范围：仅 SeatActivationDispatcher 模块内部使用。
 */
export type PendingSeatActivation = Readonly<{
  seatVersion: number;
  oldSymbol: string | null;
}>;

/**
 * 席位激活调度器依赖。
 * 类型用途：创建 runtime 阶段 ACTIVATING -> SEAT_REFRESH producer 所需的事件源与队列。
 * 数据来源：app runtime 装配层。
 * 使用范围：SeatActivationDispatcher 工厂。
 */
export type SeatActivationDispatcherDeps = Readonly<{
  tradingConfig: MultiMonitorTradingConfig;
  symbolRegistry: SymbolRegistry;
  monitorTaskQueue: MonitorTaskQueue<MonitorTaskDataMap>;
}>;

/**
 * 席位激活调度器。
 * 类型用途：将 runtime 阶段 seat 进入 ACTIVATING 的事件转换为 SEAT_REFRESH 任务。
 * 数据来源：由 createSeatActivationDispatcher 创建。
 * 使用范围：app 装配、lifecycle 与 cleanup。
 */
export interface SeatActivationDispatcher {
  readonly start: () => void;
  readonly stop: () => void;
  readonly dispatchCurrentActivatingSeats: () => void;
}

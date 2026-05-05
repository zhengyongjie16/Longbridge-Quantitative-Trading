import type { MultiMonitorTradingConfig } from '../../types/config.js';
import type { MonitorContext } from '../../types/state.js';
import type { SymbolRegistry } from '../../types/seat.js';
import type {
  PostTradeConsistencyFreshReachedEvent,
  Trader,
  Unsubscribe,
} from '../../types/services.js';
import type { MonitorTaskQueue } from '../asyncProgram/monitorTaskQueue/types.js';
import type {
  MonitorTaskDataMap,
  MonitorTaskStatus,
} from '../asyncProgram/monitorTaskProcessor/types.js';
import type { TradingGateEventRuntime } from '../tradingGateEventRuntime/types.js';

/**
 * 周期换标 route。
 * 类型用途：以结构化字段标识某监控标的某方向的周期换标路线。
 * 数据来源：启动 seed、seat truth 事件和 gate 事件中的 monitorSymbol/direction。
 * 使用范围：PeriodicSwitchWakeupRuntime 的公开方法与内部排程。
 */
export type PeriodicSwitchRoute = Readonly<{
  /** 监控标的代码 */
  monitorSymbol: string;

  /** 席位方向 */
  direction: 'LONG' | 'SHORT';
}>;

/**
 * 周期换标方向。
 * 类型用途：从 PeriodicSwitchRoute 结构化 route 提取方向类型，避免运行时代码重复定义联合类型。
 * 数据来源：PeriodicSwitchRoute.direction。
 * 使用范围：PeriodicSwitchWakeupRuntime 内部路线遍历。
 */
export type PeriodicSwitchDirection = PeriodicSwitchRoute['direction'];

/**
 * 周期换标 route baseline。
 * 类型用途：记录派发或等待时的 ACTIVE seat 权威快照，用于隔离旧 timer 与旧任务回调。
 * 数据来源：SymbolRegistry.getSeatState/getSeatVersion 与 MonitorContext.config。
 * 使用范围：AUTO_SYMBOL_TICK 入队、waiting-empty 标记和任务完成后重排校验。
 */
export type PeriodicSwitchRouteBaseline = Readonly<{
  /** 监控标的代码 */
  monitorSymbol: string;

  /** 席位方向 */
  direction: 'LONG' | 'SHORT';

  /** 当前席位标的 */
  symbol: string;

  /** 当前席位版本 */
  seatVersion: number;

  /** 最近一次进入 ACTIVE 状态时间戳 */
  lastSeatActivatedAt: number;
}>;

/**
 * 周期换标到期时间计算参数。
 * 类型用途：把 seat ACTIVE 起点与配置间隔传入纯计算依赖。
 * 数据来源：PeriodicSwitchWakeupRuntime 从当前 baseline 与 monitor config 组装。
 * 使用范围：PeriodicSwitchWakeupRuntimeDeps.calculateDueAtMs。
 */
type PeriodicSwitchDueCalculationParams = Readonly<{
  /** ACTIVE 起点时间戳 */
  startMs: number;

  /** 周期换标间隔分钟数 */
  switchIntervalMinutes: number;
}>;

/**
 * 周期换标 timer 句柄。
 * 类型用途：保存由注入 scheduleTimer 返回的 one-shot timer 句柄。
 * 数据来源：PeriodicSwitchWakeupRuntimeDeps.scheduleTimer。
 * 使用范围：PeriodicSwitchWakeupRuntime 内部状态。
 */
type PeriodicSwitchTimerHandle = ReturnType<typeof setTimeout>;

/**
 * 周期换标 AUTO_SYMBOL_TICK payload。
 * 类型用途：复用 AUTO_SYMBOL_TICK 的完整 ACTIVE baseline 数据。
 * 数据来源：PeriodicSwitchRouteBaseline。
 * 使用范围：PeriodicSwitchWakeupRuntime 入队任务。
 */
export type PeriodicSwitchAutoSymbolTickTaskData = MonitorTaskDataMap['AUTO_SYMBOL_TICK'];

/**
 * 周期换标单 route 运行态。
 * 类型用途：记录当前 baseline、one-shot timer 和 waiting-empty 标记。
 * 数据来源：PeriodicSwitchWakeupRuntime 按 route key 维护。
 * 使用范围：PeriodicSwitchWakeupRuntime 内部状态表。
 */
export type PeriodicSwitchRouteState = {
  /** 当前权威 baseline */
  baseline: PeriodicSwitchRouteBaseline | null;

  /** 当前 one-shot timer 句柄 */
  timerHandle: PeriodicSwitchTimerHandle | null;

  /** 当前 waiting-empty baseline */
  waitingEmpty: PeriodicSwitchRouteBaseline | null;

  /** 已 fail-fast 终止的 baseline，直到席位 baseline 变化前不再重派 */
  failedBaseline: PeriodicSwitchRouteBaseline | null;
};

/**
 * 周期换标 runtime 依赖。
 * 类型用途：创建周期换标 due timer owner 所需的状态读取、事件源、任务队列与 timer 能力。
 * 数据来源：app runtime 装配层。
 * 使用范围：createPeriodicSwitchWakeupRuntime 工厂。
 */
export type PeriodicSwitchWakeupRuntimeDeps = Readonly<{
  /** 交易配置中的监控标的列表 */
  tradingConfig: Pick<MultiMonitorTradingConfig, 'monitors'>;

  /** 当前 monitor contexts */
  monitorContexts: ReadonlyMap<string, Pick<MonitorContext, 'config'>>;

  /** 权威席位注册表 */
  symbolRegistry: Pick<SymbolRegistry, 'getSeatState' | 'getSeatVersion' | 'onSeatTruthChanged'>;

  /** 监控任务队列 */
  monitorTaskQueue: Pick<MonitorTaskQueue<MonitorTaskDataMap>, 'scheduleLatest'>;

  /** 订单事件源 */
  trader: Pick<Trader, 'onOrderStateChanged'>;

  /** 成交后一致性 fresh 事件源 */
  postTradeConsistencyRuntime: Readonly<{
    onFreshReached: (
      listener: (event: PostTradeConsistencyFreshReachedEvent) => void,
    ) => Unsubscribe;
  }>;

  /** 交易门禁事件源 */
  tradingGateEventRuntime: Pick<TradingGateEventRuntime, 'onGateStateChanged'>;

  /** 周期换标到期时间计算 */
  calculateDueAtMs: (params: PeriodicSwitchDueCalculationParams) => number | null;

  /** 当前时间 */
  now: () => Date;

  /** 注册 one-shot timer */
  scheduleTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;

  /** 清理 timer */
  clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
}>;

/**
 * 周期换标 wakeup runtime。
 * 类型用途：运行期周期换标 due timer 与 waiting-empty 重派发的唯一 owner。
 * 数据来源：由 createPeriodicSwitchWakeupRuntime 创建。
 * 使用范围：app 装配、AUTO_SYMBOL_TICK 任务结果回写与 lifecycle cleanup。
 */
export interface PeriodicSwitchWakeupRuntime {
  /** 启动事件订阅并 seed 当前配置路线 */
  readonly start: () => void;

  /** 停止订阅、清理 timer 与 waiting-empty 状态 */
  readonly stopAndDrain: () => Promise<void>;

  /** 标记当前 baseline 进入 waiting-empty 等待 */
  readonly markWaitingEmpty: (baseline: PeriodicSwitchRouteBaseline) => void;

  /** 清理当前 baseline 的 waiting-empty 等待 */
  readonly clearWaitingEmpty: (baseline: PeriodicSwitchRouteBaseline) => void;

  /** AUTO_SYMBOL_TICK 结束后按当前 baseline 与处理结果重排 route */
  readonly replanRouteAfterTask: (
    params: PeriodicSwitchRouteBaseline &
      Readonly<{
        taskTimeMs: number;
        status: MonitorTaskStatus;
      }>,
  ) => void;
}

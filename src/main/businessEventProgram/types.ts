import type { MonitorContext, LastState } from '../../types/state.js';
import type { MultiMonitorTradingConfig } from '../../types/config.js';
import type { MarketDataClient } from '../../types/services.js';
import type { MonitorTaskQueue } from '../asyncProgram/monitorTaskQueue/types.js';
import type { MonitorTaskDataMap } from '../asyncProgram/monitorTaskProcessor/types.js';
import type { BuyTaskType, SellTaskType, TaskQueue } from '../asyncProgram/tradeTaskQueue/types.js';

/**
 * K 线业务程序行为契约。
 * 类型用途：统一普通 K 线业务 owner 的启停能力。
 * 数据来源：由 createBusinessEventProgram 创建。
 * 使用范围：app 装配、lifecycle、cleanup 使用。
 */
export interface BusinessEventProgram {
  /** 启动 K 线事件监听。 */
  readonly start: () => void;

  /** 停止监听并等待在途业务路由完成。 */
  readonly stopAndDrain: () => Promise<void>;
}

/**
 * 单 monitor 的业务事件路由状态。
 * 类型用途：实现 per-monitor single-flight + latest-only collapse。
 * 数据来源：由 businessEventProgram 在运行期维护。
 * 使用范围：仅 businessEventProgram 模块内部使用。
 */
export type BusinessEventRouteState = {
  inFlight: boolean;
  dirty: boolean;
};

/**
 * K 线业务程序依赖。
 * 类型用途：收口普通 K 线业务 owner 所需的共享服务、状态与任务队列。
 * 数据来源：由 app 顶层装配注入。
 * 使用范围：仅 businessEventProgram 模块使用。
 */
export type BusinessEventProgramDeps = Readonly<{
  marketDataClient: Pick<MarketDataClient, 'getCandlestickSnapshot' | 'onCandlestickUpdated'>;
  monitorContexts: ReadonlyMap<string, MonitorContext>;
  lastState: LastState;
  tradingConfig: MultiMonitorTradingConfig;
  buyTaskQueue: TaskQueue<BuyTaskType>;
  sellTaskQueue: TaskQueue<SellTaskType>;
  monitorTaskQueue: MonitorTaskQueue<MonitorTaskDataMap>;
}>;

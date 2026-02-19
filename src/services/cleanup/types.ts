import type { IndicatorCache } from '../../main/asyncProgram/indicatorCache/types.js';
import type { Processor } from '../../main/asyncProgram/types.js';
import type { MonitorTaskProcessor } from '../../main/asyncProgram/monitorTaskProcessor/types.js';
import type { OrderMonitorWorker } from '../../main/asyncProgram/orderMonitorWorker/types.js';
import type { PostTradeRefresher } from '../../main/asyncProgram/postTradeRefresher/types.js';
import type { LastState, MonitorContext } from '../../types/state.js';
import type { MarketDataClient } from '../../types/services.js';

/**
 * 清理上下文接口。
 * 类型用途：作为 createCleanup 的入参，封装程序退出时需要释放的处理器与资源引用（含 lastState 用于释放监控快照）。
 * 数据来源：由主程序构造并传入 createCleanup。
 * 使用范围：仅 cleanup 模块内部使用。
 */
export type CleanupContext = {
  readonly buyProcessor: Processor;
  readonly sellProcessor: Processor;
  readonly monitorTaskProcessor: MonitorTaskProcessor;
  readonly orderMonitorWorker: OrderMonitorWorker;
  readonly postTradeRefresher: PostTradeRefresher;
  readonly marketDataClient: MarketDataClient;
  readonly monitorContexts: ReadonlyMap<string, MonitorContext>;
  readonly indicatorCache: IndicatorCache;
  readonly lastState: LastState;
};

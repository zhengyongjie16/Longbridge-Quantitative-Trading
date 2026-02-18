import type { IndicatorCache } from '../../main/asyncProgram/indicatorCache/types.js';
import type { Processor } from '../../main/asyncProgram/types.js';
import type { MonitorTaskProcessor } from '../../main/asyncProgram/monitorTaskProcessor/types.js';
import type { OrderMonitorWorker } from '../../main/asyncProgram/orderMonitorWorker/types.js';
import type { PostTradeRefresher } from '../../main/asyncProgram/postTradeRefresher/types.js';
import type { LastState, MonitorContext } from '../../types/state.js';
import type { MarketDataClient } from '../../types/services.js';

/**
 * 清理上下文接口，包含程序退出时需要清理的所有资源引用。
 * 由主程序构造并传入 createCleanup，仅在 cleanup 模块内部使用。
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

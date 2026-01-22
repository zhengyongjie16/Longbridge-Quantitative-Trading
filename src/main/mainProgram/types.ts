/**
 * mainProgram 模块类型定义
 */
import type { IndicatorCache } from '../asyncProgram/indicatorCache/types.js';
import type { BuyTaskQueue, SellTaskQueue } from '../asyncProgram/types.js';
import type { BuyProcessor } from '../asyncProgram/buyProcessor/types.js';
import type { SellProcessor } from '../asyncProgram/sellProcessor/types.js';
import type {
  LastState,
  MonitorContext,
  MarketDataClient,
  Trader,
} from '../../types/index.js';
import type { MarketMonitor } from '../../services/marketMonitor/types.js';
import type { DoomsdayProtection } from '../../core/doomsdayProtection/types.js';
import type { SignalProcessor } from '../../core/signalProcessor/types.js';

/**
 * 主程序上下文 - mainProgram 运行所需的所有依赖
 */
export type MainProgramContext = {
  readonly marketDataClient: MarketDataClient;
  readonly trader: Trader;
  readonly lastState: LastState;
  readonly marketMonitor: MarketMonitor;
  readonly doomsdayProtection: DoomsdayProtection;
  readonly signalProcessor: SignalProcessor;
  readonly monitorContexts: Map<string, MonitorContext>;
  readonly indicatorCache: IndicatorCache;
  readonly buyTaskQueue: BuyTaskQueue;
  readonly sellTaskQueue: SellTaskQueue;
  readonly buyProcessor: BuyProcessor;
  readonly sellProcessor: SellProcessor;
};

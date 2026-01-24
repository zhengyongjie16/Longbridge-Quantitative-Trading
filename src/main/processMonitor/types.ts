/**
 * processMonitor 模块类型定义
 */

import type { IndicatorCache } from '../asyncProgram/indicatorCache/types.js';
import type { BuyTaskQueue, SellTaskQueue } from '../asyncProgram/types.js';
import type {
  MonitorContext,
  MarketDataClient,
  Trader,
  LastState,
} from '../../types/index.js';
import type { MarketMonitor } from '../../services/marketMonitor/types.js';
import type { DoomsdayProtection } from '../../core/doomsdayProtection/types.js';
import type { SignalProcessor } from '../../core/signalProcessor/types.js';

/**
 * processMonitor 函数参数类型
 */
export type ProcessMonitorParams = {
  readonly monitorContext: MonitorContext;
  readonly marketDataClient: MarketDataClient;
  readonly trader: Trader;
  readonly globalState: LastState;
  readonly marketMonitor: MarketMonitor;
  readonly doomsdayProtection: DoomsdayProtection;
  readonly signalProcessor: SignalProcessor;
  readonly currentTime: Date;
  readonly isHalfDay: boolean;
  readonly canTradeNow: boolean;
  readonly openProtectionActive: boolean;
  readonly indicatorCache: IndicatorCache;
  readonly buyTaskQueue: BuyTaskQueue;
  readonly sellTaskQueue: SellTaskQueue;
};

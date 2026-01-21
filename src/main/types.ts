/**
 * 主程序初始化相关类型定义
 */

import type { IndicatorCache } from '../program/indicatorCache/types.js';
import type { BuyTaskQueue, SellTaskQueue } from '../program/tradeTaskQueue/types.js';
import type { BuyProcessor } from '../program/buyProcessor/types.js';
import type { SellProcessor } from '../program/sellProcessor/types.js';
import type {
  LastState,
  MonitorContext,
  MarketDataClient,
  Trader,
} from '../types/index.js';
import type { MarketMonitor } from '../services/marketMonitor/types.js';
import type { DoomsdayProtection } from '../core/doomsdayProtection/types.js';
import type { SignalProcessor } from '../core/signalProcessor/types.js';

/**
 * 运行上下文接口
 * 包含主循环 runOnce 所需的所有依赖
 */
export type RunOnceContext = {
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

/**
 * 清理上下文接口
 * 包含程序退出时需要清理的资源
 */
export type CleanupContext = {
  readonly buyProcessor: BuyProcessor;
  readonly sellProcessor: SellProcessor;
  readonly monitorContexts: Map<string, MonitorContext>;
  readonly indicatorCache: IndicatorCache;
  readonly lastState: LastState;
};

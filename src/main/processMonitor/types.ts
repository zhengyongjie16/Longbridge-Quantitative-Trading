/**
 * @module processMonitor/types
 * @description processMonitor 模块的类型定义
 *
 * 定义单个监控标的处理所需的参数类型
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
 *
 * 包含处理单个监控标的所需的所有依赖：
 * - monitorContext: 当前监控标的的上下文（配置、状态、策略等）
 * - 外部服务：marketDataClient、trader、marketMonitor 等
 * - 运行状态：currentTime、isHalfDay、canTradeNow、openProtectionActive
 * - 异步架构：indicatorCache、buyTaskQueue、sellTaskQueue
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

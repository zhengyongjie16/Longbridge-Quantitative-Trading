/**
 * TradeProcessor 类型定义
 */

import type { MonitorContext, Trader, LastState } from '../../types/index.js';
import type { TradeTaskQueue } from '../tradeTaskQueue/types.js';
import type { SignalProcessor } from '../../core/signalProcessor/types.js';
import type { DoomsdayProtection } from '../../core/doomsdayProtection/types.js';

/**
 * 处理器统计信息
 */
export type ProcessorStats = {
  readonly processedCount: number;
  readonly successCount: number;
  readonly failedCount: number;
  readonly lastProcessTime: number | null;
};

/**
 * 交易处理器接口
 */
export interface TradeProcessor {
  start(): void;
  stop(): void;
  processNow(): Promise<void>;
  isRunning(): boolean;
  getStats(): ProcessorStats;
}

/**
 * 交易处理器依赖类型
 */
export type TradeProcessorDeps = {
  readonly taskQueue: TradeTaskQueue;
  readonly getMonitorContext: (monitorSymbol: string) => MonitorContext | undefined;
  readonly signalProcessor: SignalProcessor;
  readonly trader: Trader;
  readonly doomsdayProtection: DoomsdayProtection;
  readonly getLastState: () => LastState;
  readonly getIsHalfDay: () => boolean;
};


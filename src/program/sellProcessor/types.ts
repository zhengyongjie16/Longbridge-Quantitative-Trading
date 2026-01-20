/**
 * SellProcessor 类型定义
 */

import type { MonitorContext, Trader, LastState } from '../../types/index.js';
import type { SellTaskQueue } from '../sellTaskQueue/types.js';
import type { SignalProcessor } from '../../core/signalProcessor/types.js';

/**
 * 处理器统计信息
 */
export type SellProcessorStats = {
  readonly processedCount: number;
  readonly successCount: number;
  readonly failedCount: number;
  readonly lastProcessTime: number | null;
};

/**
 * 卖出处理器接口
 */
export interface SellProcessor {
  start(): void;
  stop(): void;
  processNow(): Promise<void>;
  isRunning(): boolean;
  getStats(): SellProcessorStats;
}

/**
 * 卖出处理器依赖类型
 */
export type SellProcessorDeps = {
  readonly taskQueue: SellTaskQueue;
  readonly getMonitorContext: (monitorSymbol: string) => MonitorContext | undefined;
  readonly signalProcessor: SignalProcessor;
  readonly trader: Trader;
  readonly getLastState: () => LastState;
};

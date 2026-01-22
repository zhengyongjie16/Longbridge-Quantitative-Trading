/**
 * SellProcessor 类型定义
 */

import type { MonitorContext, Trader, LastState } from '../../../types/index.js';
import type { ProcessorStats, SellTaskQueue } from '../types.js';
import type { SignalProcessor } from '../../../core/signalProcessor/types.js';

/**
 * 卖出处理器接口
 */
export interface SellProcessor {
  start(): void;
  stop(): void;
  processNow(): Promise<void>;
  isRunning(): boolean;
  getStats(): ProcessorStats;
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

/**
 * BuyProcessor 类型定义
 * 专用于处理买入信号
 */

import type { MonitorContext, Trader, LastState } from '../../types/index.js';
import type { BuyTaskQueue } from '../buyTaskQueue/types.js';
import type { SignalProcessor } from '../../core/signalProcessor/types.js';
import type { DoomsdayProtection } from '../../core/doomsdayProtection/types.js';

/**
 * 处理器统计信息
 */
export type BuyProcessorStats = {
  readonly processedCount: number;
  readonly successCount: number;
  readonly failedCount: number;
  readonly lastProcessTime: number | null;
};

/**
 * 买入处理器接口
 */
export interface BuyProcessor {
  start(): void;
  stop(): void;
  processNow(): Promise<void>;
  isRunning(): boolean;
  getStats(): BuyProcessorStats;
}

/**
 * 买入处理器依赖类型
 */
export type BuyProcessorDeps = {
  readonly taskQueue: BuyTaskQueue;
  readonly getMonitorContext: (monitorSymbol: string) => MonitorContext | undefined;
  readonly signalProcessor: SignalProcessor;
  readonly trader: Trader;
  readonly doomsdayProtection: DoomsdayProtection;
  readonly getLastState: () => LastState;
  readonly getIsHalfDay: () => boolean;
};

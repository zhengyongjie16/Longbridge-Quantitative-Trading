/**
 * BuyProcessor 模块类型定义
 *
 * 定义买入处理器的接口契约和依赖注入类型
 */

import type { MonitorContext, Trader, LastState } from '../../../types/index.js';
import type { BuyTaskQueue, ProcessorStats } from '../types.js';
import type { SignalProcessor } from '../../../core/signalProcessor/types.js';
import type { DoomsdayProtection } from '../../../core/doomsdayProtection/types.js';

/**
 * 买入处理器接口
 *
 * 提供启动/停止、立即处理、状态查询等能力
 */
export interface BuyProcessor {
  /** 启动处理器，开始消费任务队列 */
  start(): void;
  /** 停止处理器 */
  stop(): void;
  /** 立即处理队列中所有任务（同步等待完成） */
  processNow(): Promise<void>;
  /** 检查处理器是否正在运行 */
  isRunning(): boolean;
  /** 获取处理器统计信息 */
  getStats(): ProcessorStats;
}

/**
 * 买入处理器依赖类型
 *
 * 通过依赖注入获取所需的外部服务和上下文
 */
export type BuyProcessorDeps = {
  /** 买入任务队列 */
  readonly taskQueue: BuyTaskQueue;
  /** 获取监控上下文的函数 */
  readonly getMonitorContext: (monitorSymbol: string) => MonitorContext | undefined;
  /** 信号处理器（风险检查） */
  readonly signalProcessor: SignalProcessor;
  /** 交易执行器 */
  readonly trader: Trader;
  /** 末日保护模块 */
  readonly doomsdayProtection: DoomsdayProtection;
  /** 获取全局状态的函数 */
  readonly getLastState: () => LastState;
  /** 获取是否半日市的函数 */
  readonly getIsHalfDay: () => boolean;
};

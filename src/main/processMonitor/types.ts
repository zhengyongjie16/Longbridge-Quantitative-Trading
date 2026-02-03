/**
 * @module processMonitor/types
 * @description processMonitor 模块的类型定义
 *
 * 定义单个监控标的处理所需的参数类型
 */

import type { MonitorContext } from '../../types/index.js';
import type { MainProgramContext } from '../mainProgram/types.js';

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
  readonly context: MainProgramContext;
  readonly monitorContext: MonitorContext;
  readonly runtimeFlags: {
    readonly currentTime: Date;
    readonly isHalfDay: boolean;
    readonly canTradeNow: boolean;
    readonly openProtectionActive: boolean;
  };
};

/**
 * 队列清理结果
 */
export type QueueClearResult = Readonly<{
  removedDelayed: number;
  removedBuy: number;
  removedSell: number;
  removedMonitorTasks: number;
}>;

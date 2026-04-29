/**
 * 单标的时间维护模块
 *
 * 核心职责：
 * - 处理时间循环中的单个监控标的维护任务
 * - 调度自动换标 tick
 * - 不负责席位同步、普通 K 线指标推进、普通信号生成或终端显示
 */
import { scheduleAutoSymbolTasks } from './autoSymbolTasks.js';

import type { ProcessMonitorParams } from './types.js';

/**
 * 处理单个监控标的的时间语义任务。
 *
 * @param context 处理上下文，包含自动换标任务调度所需依赖和运行时状态
 */
export function processMonitor(context: ProcessMonitorParams): void {
  const { monitorContext, context: mainContext, currentTime } = context;
  const { config } = monitorContext;

  const MONITOR_SYMBOL = config.monitorSymbol;
  const autoSearchEnabled = config.autoSearchConfig.autoSearchEnabled;

  scheduleAutoSymbolTasks({
    monitorSymbol: MONITOR_SYMBOL,
    monitorContext,
    mainContext,
    autoSearchEnabled,
    currentTimeMs: currentTime.getTime(),
  });
}

/**
 * 单标的处理模块
 *
 * 核心职责：
 * - 处理时间循环中的单个监控标的维护任务
 * - 调度自动换标 tick
 * - 同步席位状态、名称缓存与 ACTIVE 退场清理
 * - 不再负责普通 K 线指标推进、普通信号生成或终端显示
 *
 * 执行流程：
 * - 自动换标任务调度 → 席位同步
 */
import { scheduleAutoSymbolTasks } from './autoSymbolTasks.js';
import { syncSeatState } from './seatSync.js';

import type { Quote } from '../../types/quote.js';
import type { ProcessMonitorParams } from './types.js';

/**
 * 处理单个监控标的
 *
 * @param context 处理上下文，包含所有必要的依赖和状态
 * @param quotesMap 预先批量获取的行情数据 Map（提升性能，避免每个监控标的单独获取行情）
 */
export function processMonitor(
  context: ProcessMonitorParams,
  quotesMap: ReadonlyMap<string, Quote | null>,
): void {
  const { monitorContext, context: mainContext, runtimeFlags } = context;
  const { canTradeNow } = runtimeFlags;
  const { config } = monitorContext;

  const MONITOR_SYMBOL = config.monitorSymbol;
  const autoSearchEnabled = config.autoSearchConfig.autoSearchEnabled;

  const currentTimeMs = runtimeFlags.currentTime.getTime();

  scheduleAutoSymbolTasks({
    monitorSymbol: MONITOR_SYMBOL,
    monitorContext,
    mainContext,
    autoSearchEnabled,
    currentTimeMs,
    canTradeNow,
    openProtectionActive: runtimeFlags.openProtectionActive,
  });

  syncSeatState({
    monitorSymbol: MONITOR_SYMBOL,
    monitorContext,
    mainContext,
    quotesMap,
  });
}

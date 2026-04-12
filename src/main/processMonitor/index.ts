/**
 * 单标的处理模块
 *
 * 核心职责：
 * - 处理单个监控标的的完整交易循环
 * - 实时监控价格变化并调度风险/换标任务
 * - 不再负责普通 K 线指标推进或普通信号生成
 *
 * 执行流程：
 * - 提取行情数据 → 自动换标任务调度 → 席位同步 → 风险展示刷新
 */
import { signalObjectPool } from '../../utils/objectPool/index.js';
import { scheduleAutoSymbolTasks } from './autoSymbolTasks.js';
import { scheduleRiskTasks } from './riskTasks.js';
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

  // 1. 从预先获取的行情 Map 中提取监控标的行情（无需单独 API 调用）
  const monitorQuote = quotesMap.get(MONITOR_SYMBOL) ?? null;

  const monitorCurrentPrice = monitorQuote?.price ?? null;

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

  const seatInfo = syncSeatState({
    monitorSymbol: MONITOR_SYMBOL,
    monitorContext,
    mainContext,
    quotesMap,
    releaseSignal: (signal) => {
      signalObjectPool.release(signal);
    },
  });

  scheduleRiskTasks({
    monitorContext,
    mainContext,
    seatInfo,
    monitorCurrentPrice,
  });
}

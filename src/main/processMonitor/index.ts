/**
 * 单标的处理模块
 *
 * 核心职责：
 * - 处理单个监控标的的完整交易循环
 * - 实时监控价格变化和浮亏状态
 * - 获取 K 线数据，计算技术指标
 * - 生成交易信号并分发到对应队列
 *
 * 执行流程：
 * - 提取行情数据 → 自动换标/席位同步 → 监控价格/浮亏变化
 * - 获取 K 线/计算指标 → 缓存指标快照 → 获取持仓
 * - 生成信号 → 分流信号到队列/验证器
 *
 * 信号处理规则：
 * - 开盘保护期间：跳过信号生成，仅保留行情/指标展示
 *
 * 信号分流规则（交易时段内）：
 * - 立即卖出信号 → SellTaskQueue
 * - 立即买入信号 → BuyTaskQueue
 * - 延迟验证信号 → DelayedSignalVerifier
 */
import { MONITOR } from '../../constants/index.js';
import { positionObjectPool, signalObjectPool } from '../../utils/objectPool/index.js';
import { scheduleAutoSymbolTasks } from './autoSymbolTasks.js';
import { runIndicatorPipeline } from './indicatorPipeline.js';
import { scheduleRiskTasks } from './riskTasks.js';
import { syncSeatState } from './seatSync.js';
import { runSignalPipeline } from './signalPipeline.js';

import type { Quote } from '../../types/quote.js';
import type { ProcessMonitorParams } from './types.js';

/**
 * 处理单个监控标的
 *
 * @param context 处理上下文，包含所有必要的依赖和状态
 * @param quotesMap 预先批量获取的行情数据 Map（提升性能，避免每个监控标的单独获取行情）
 */
export async function processMonitor(
  context: ProcessMonitorParams,
  quotesMap: ReadonlyMap<string, Quote | null>,
): Promise<void> {
  const { monitorContext, context: mainContext, runtimeFlags } = context;
  const { canTradeNow } = runtimeFlags;
  const { config, state } = monitorContext;

  const MONITOR_SYMBOL = config.monitorSymbol;
  const autoSearchEnabled = config.autoSearchConfig.autoSearchEnabled;

  // 1. 从预先获取的行情 Map 中提取监控标的行情（无需单独 API 调用）
  const monitorQuote = quotesMap.get(MONITOR_SYMBOL) ?? null;

  const monitorCurrentPrice = monitorQuote?.price ?? null;
  const resolvedMonitorPrice = Number.isFinite(monitorCurrentPrice) ? monitorCurrentPrice : null;
  const lastMonitorPrice = Number.isFinite(state.monitorPrice) ? state.monitorPrice : null;
  const monitorPriceChanged =
    resolvedMonitorPrice !== null &&
    resolvedMonitorPrice !== undefined &&
    (lastMonitorPrice === null ||
      lastMonitorPrice === undefined ||
      Math.abs(resolvedMonitorPrice - lastMonitorPrice) > MONITOR.PRICE_CHANGE_THRESHOLD);
  if (monitorPriceChanged) {
    state.monitorPrice = resolvedMonitorPrice;
  }

  const currentTimeMs = runtimeFlags.currentTime.getTime();

  scheduleAutoSymbolTasks({
    monitorSymbol: MONITOR_SYMBOL,
    monitorContext,
    mainContext,
    autoSearchEnabled,
    currentTimeMs,
    canTradeNow,
    openProtectionActive: runtimeFlags.openProtectionActive,
    monitorPriceChanged,
    resolvedMonitorPrice,
    quotesMap,
  });

  const seatInfo = syncSeatState({
    monitorSymbol: MONITOR_SYMBOL,
    monitorQuote,
    monitorContext,
    mainContext,
    quotesMap,
    releaseSignal: signalObjectPool.release,
  });

  scheduleRiskTasks({
    monitorSymbol: MONITOR_SYMBOL,
    monitorContext,
    mainContext,
    seatInfo,
    autoSearchEnabled,
    monitorPriceChanged,
    resolvedMonitorPrice,
    monitorCurrentPrice,
  });

  const monitorSnapshot = await runIndicatorPipeline({
    monitorSymbol: MONITOR_SYMBOL,
    monitorContext,
    mainContext,
    monitorQuote,
  });

  if (!monitorSnapshot) {
    return;
  }

  runSignalPipeline({
    monitorSymbol: MONITOR_SYMBOL,
    monitorContext,
    mainContext,
    runtimeFlags,
    seatInfo,
    monitorSnapshot,
    releaseSignal: signalObjectPool.release,
    releasePosition: positionObjectPool.release,
  });
}

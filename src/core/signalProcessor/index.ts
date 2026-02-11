/**
 * 信号处理模块
 *
 * 功能：
 * - 对生成的信号进行过滤和风险检查
 * - 计算卖出信号的数量和清仓策略
 * - 实施交易频率限制
 *
 * 买入检查顺序：
 * 1. 交易频率限制（同方向买入时间间隔）
 * 2. 清仓冷却（保护性清仓后的冷却期）
 * 3. 买入价格限制（防止追高）
 * 4. 末日保护程序（收盘前 15 分钟拒绝买入）
 * 5. 牛熊证风险检查
 * 6. 基础风险检查（浮亏和持仓限制）
 *
 * 卖出策略：
 * - 智能平仓开启：仅卖出盈利订单
 * - 智能平仓关闭：清空所有持仓
 * - 无符合条件订单：信号设为 HOLD
 */
import { createRiskCheckPipeline } from './riskCheckPipeline.js';
import { processSellSignals } from './sellQuantityCalculator.js';
import type { SignalProcessor, SignalProcessorDeps } from './types.js';

/** 创建信号处理器（工厂函数） */
export const createSignalProcessor = ({
  tradingConfig,
  liquidationCooldownTracker,
}: SignalProcessorDeps): SignalProcessor => {
  /** 冷却时间记录：Map<symbol_direction, timestamp>，防止重复信号频繁触发风险检查 */
  const lastRiskCheckTime = new Map<string, number>();
  const applyRiskChecks = createRiskCheckPipeline({
    tradingConfig,
    liquidationCooldownTracker,
    lastRiskCheckTime,
  });

  return {
    processSellSignals,
    applyRiskChecks,
  };
};


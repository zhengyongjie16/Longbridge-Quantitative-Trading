import type { Position } from '../../types/account.js';
import type { Quote } from '../../types/quote.js';
import type { Signal } from '../../types/signal.js';
import type { MultiMonitorTradingConfig } from '../../types/config.js';
import type { OrderRecorder, RiskCheckContext } from '../../types/services.js';
import type { LiquidationCooldownTracker } from '../../services/liquidationCooldown/types.js';
import type { TradingCalendarSnapshot } from '../../utils/helpers/types.js';

// ==================== 结果类型定义 ====================

/**
 * 卖出上下文校验结果（联合类型）。
 * 类型用途：卖出前校验的返回类型，valid=true 时包含可用数量与当前价，valid=false 时包含失败原因。
 * 数据来源：如适用（由卖出流程中的校验逻辑构造）。
 * 使用范围：仅 signalProcessor 模块内部使用。
 */
export type SellContextValidationResult =
  | {
      readonly valid: true;
      readonly availableQuantity: number;
      readonly currentPrice: number;
    }
  | {
      readonly valid: false;
      readonly reason: string;
    };

/**
 * 卖出信号处理参数。
 * 类型用途：processSellSignals 的对象入参，统一承载卖出计算所需上下文（行情/持仓/配置/时间快照）。
 * 数据来源：sellProcessor 组装并传入。
 * 使用范围：仅 signalProcessor 模块内部与调用方使用。
 */
export type ProcessSellSignalsParams = {
  readonly signals: Signal[];
  readonly longPosition: Position | null;
  readonly shortPosition: Position | null;
  readonly longQuote: Quote | null;
  readonly shortQuote: Quote | null;
  readonly orderRecorder: OrderRecorder;
  readonly smartCloseEnabled: boolean;
  readonly smartCloseTimeoutMinutes: number | null;
  readonly nowMs: number;
  readonly isHalfDay: boolean;
  readonly tradingCalendarSnapshot: TradingCalendarSnapshot;
};

// ==================== 服务接口定义 ====================

/**
 * 信号处理器接口。
 * 类型用途：依赖注入，负责卖出信号的数量计算与买入信号的风险检查（含冷却、频率、牛熊证等）。
 * 数据来源：如适用。
 * 使用范围：主程序持有并调用；仅 signalProcessor 模块实现。
 */
export interface SignalProcessor {
  /**
   * 处理卖出信号，计算实际卖出数量
   * 根据智能平仓配置决定是全仓卖出还是按三阶段智能平仓卖出
   */
  processSellSignals: (params: ProcessSellSignalsParams) => Signal[];

  /**
   * 对信号列表应用风险检查
   * 检查顺序：验证冷却 → 交易频率 → 清仓冷却 → 买入价格限制 → 末日保护 → 牛熊证风险 → 基础风险
   */
  applyRiskChecks: (signals: Signal[], context: RiskCheckContext) => Promise<Signal[]>;

  /**
   * 清空风险检查冷却时间记录
   * 跨日或重置场景下调用，确保新的一天不受前一天冷却状态影响
   */
  resetRiskCheckCooldown: () => void;
}

// ==================== 依赖类型定义 ====================

/**
 * 信号处理器依赖类型。
 * 类型用途：创建 SignalProcessor 时的依赖注入，包含全局交易配置与清仓冷却追踪等。
 * 数据来源：如适用。
 * 使用范围：见调用方（如主程序/processMonitor）。
 */
export type SignalProcessorDeps = {
  readonly tradingConfig: MultiMonitorTradingConfig;
  readonly liquidationCooldownTracker: LiquidationCooldownTracker;
};

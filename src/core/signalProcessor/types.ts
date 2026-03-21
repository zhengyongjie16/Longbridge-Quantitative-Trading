import type { Position } from '../../types/account.js';
import type { Quote } from '../../types/quote.js';
import type { Signal } from '../../types/signal.js';
import type { MultiMonitorTradingConfig } from '../../types/config.js';
import type { OrderRecorder, RiskCheckContext } from '../../types/services.js';
import type { LiquidationCooldownTracker } from '../../services/liquidationCooldown/types.js';
import type { TradingCalendarSnapshot } from '../../types/tradingCalendar.js';

// ==================== 结果类型定义 ====================

/**
 * 卖出上下文校验结果（联合类型）。
 * 类型用途：描述卖出前上下文校验结果，成功时携带可用数量与当前价，失败时携带拒绝原因。
 * 数据来源：由 signalProcessor 卖出前校验逻辑构造。
 * 使用范围：仅 signalProcessor 模块内部与其直接调用方使用。
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
 * 卖出信号处理入参。
 * 类型用途：统一承载 processSellSignals 卖出数量计算所需的行情、持仓、订单记录与时间上下文。
 * 数据来源：由卖出处理链路在调用前组装。
 * 使用范围：signalProcessor 模块与调用方之间的参数契约。
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
 * 类型用途：定义卖出数量计算与买入/卖出信号风险检查能力，供主程序依赖注入。
 * 数据来源：由 createSignalProcessor 工厂实现并返回。
 * 使用范围：主程序与异步处理器通过该接口调用 signalProcessor 能力。
 */
export interface SignalProcessor {
  /**
   * 处理卖出信号，计算实际卖出数量
   * 根据智能平仓配置决定是全仓卖出还是按三阶段智能平仓卖出
   */
  processSellSignals: (params: ProcessSellSignalsParams) => Signal[];

  /**
   * 对信号列表应用风险检查。
   * 买入轻检查顺序：风险检查冷却 → 交易频率 → 清仓冷却 → 买入价格限制 → 末日保护 → 牛熊证风险。
   * 仅当上述轻检查全部通过后，才实时拉取账户/持仓并执行基础风险检查。
   * 风险检查阶段不会刷新买入频率状态，即不会在此阶段记录买入尝试。
   * 卖出路径继续使用缓存上下文 context.account/context.positions 执行基础风险检查。
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
 * 创建 SignalProcessor 所需依赖。
 * 类型用途：约束 createSignalProcessor 的依赖注入形状。
 * 数据来源：由 app 组装层在启动时注入。
 * 使用范围：仅 signalProcessor 工厂创建阶段使用。
 */
export type SignalProcessorDeps = {
  readonly tradingConfig: MultiMonitorTradingConfig;
  readonly liquidationCooldownTracker: LiquidationCooldownTracker;
};

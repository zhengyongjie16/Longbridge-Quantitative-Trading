/**
 * 信号处理模块类型定义
 *
 * 定义信号处理器相关的类型，包括：
 * - 卖出数量计算结果
 * - 卖出上下文校验结果
 * - 信号处理器接口
 * - 依赖注入类型
 */

import type {
  Quote,
  Position,
  Signal,
  OrderRecorder,
  RiskCheckContext,
  MultiMonitorTradingConfig,
} from '../../types/index.js';

// ==================== 结果类型定义 ====================

/**
 * 卖出数量计算结果
 * - quantity: 计算出的卖出数量，null 表示无法计算
 * - shouldHold: 是否应保持持仓（不执行卖出）
 * - reason: 计算结果的原因说明
 */
export type SellQuantityResult = {
  readonly quantity: number | null;
  readonly shouldHold: boolean;
  readonly reason: string;
};

/**
 * 卖出上下文校验结果（联合类型）
 * - valid=true: 校验通过，包含可用数量和当前价格
 * - valid=false: 校验失败，包含失败原因
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

// ==================== 服务接口定义 ====================

/**
 * 信号处理器接口
 * 负责处理卖出信号的数量计算和买入信号的风险检查
 */
export interface SignalProcessor {
  /**
   * 处理卖出信号，计算实际卖出数量
   * 根据智能平仓配置决定是全仓卖出还是仅卖出盈利订单
   */
  processSellSignals(
    signals: Signal[],
    longPosition: Position | null,
    shortPosition: Position | null,
    longQuote: Quote | null,
    shortQuote: Quote | null,
    orderRecorder: OrderRecorder,
    smartCloseEnabled: boolean,
  ): Signal[];

  /**
   * 对信号列表应用风险检查
   * 检查顺序：冷却期 → 交易频率 → 买入价格限制 → 末日保护 → 牛熊证风险 → 基础风险
   */
  applyRiskChecks(signals: Signal[], context: RiskCheckContext): Promise<Signal[]>;
}

// ==================== 依赖类型定义 ====================

/**
 * 信号处理器依赖类型
 * 通过工厂函数注入，包含全局交易配置
 */
export type SignalProcessorDeps = {
  readonly tradingConfig: MultiMonitorTradingConfig;
};


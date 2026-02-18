/**
 * 信号类型
 * 表示交易操作的方向和动作
 */
export type SignalType =
  | 'BUYCALL'   // 买入做多
  | 'SELLCALL'  // 卖出做多
  | 'BUYPUT'    // 买入做空
  | 'SELLPUT'   // 卖出做空
  | 'HOLD';     // 持有（不操作）

/**
 * 订单类型配置
 * - LO: 限价单（Limit Order）
 * - ELO: 增强限价单（Enhanced Limit Order）
 * - MO: 市价单（Market Order）
 */
export type OrderTypeConfig = 'LO' | 'ELO' | 'MO';

/**
 * 交易信号
 * 表示一次交易操作的完整信息
 *
 * @remarks 此类型不使用 readonly，因为需要在对象池中修改
 */
export type Signal = {
  /** 交易标的代码 */
  symbol: string;
  /** 交易标的名称 */
  symbolName: string | null;
  /** 信号动作类型 */
  action: SignalType;
  /** 信号触发原因 */
  reason?: string | null;
  /** 订单类型覆盖（优先级高于全局配置） */
  orderTypeOverride?: OrderTypeConfig | null;
  /** 是否为保护性清仓（触发买入冷却） */
  isProtectiveLiquidation?: boolean | null;
  /** 交易价格 */
  price?: number | null;
  /** 每手股数 */
  lotSize?: number | null;
  /** 交易数量 */
  quantity?: number | null;
  /**
   * 信号触发时间
   * - 立即信号：信号生成时间
   * - 延迟信号：延迟验证的基准时间（T0）
   * - 末日保护信号：信号生成时间
   */
  triggerTime?: Date | null;
  /** 信号对应的席位版本号（换标后用于丢弃旧信号） */
  seatVersion?: number | null;
  /** 延迟验证：T0 时刻的指标快照 */
  indicators1?: Readonly<Record<string, number>> | null;
  /** 延迟验证：历史验证记录 */
  verificationHistory?: Array<{ timestamp: Date; indicators: Readonly<Record<string, number>> }> | null;
  /** 关联的买入订单ID列表（仅卖出订单使用，用于智能平仓防重） */
  relatedBuyOrderIds?: readonly string[] | null;
};

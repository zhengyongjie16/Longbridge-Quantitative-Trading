/**
 * 信号类型。
 * 类型用途：表示交易方向与动作（买多/卖多/买空/卖空/持有），作为 Signal.action、策略输出及门禁/买卖流程的入参。
 * 数据来源：策略模块根据指标条件输出。
 * 使用范围：Signal、策略、Trader、信号处理等；全项目可引用。
 */
export type SignalType =
  | 'BUYCALL'   // 买入做多
  | 'SELLCALL'  // 卖出做多
  | 'BUYPUT'    // 买入做空
  | 'SELLPUT'   // 卖出做空
  | 'HOLD';     // 持有（不操作）

/**
 * 订单类型配置。
 * 类型用途：限价/增强限价/市价单的配置枚举，作为 GlobalConfig.tradingOrderType、liquidationOrderType 及 Signal.orderTypeOverride 的类型。
 * 数据来源：配置解析（环境变量）。
 * 使用范围：配置、Trader 下单、Signal 覆盖等；全项目可引用。
 */
export type OrderTypeConfig = 'LO' | 'ELO' | 'MO';

/**
 * 交易信号。
 * 类型用途：单次交易操作的完整信息（标的、动作、原因、订单类型等），作为策略输出、executeSignals 入参及对象池复用的可写结构；不使用 readonly 以支持对象池修改。
 * 数据来源：策略模块生成，经延迟验证与风控后写入。
 * 使用范围：策略、信号处理、Trader、对象池等；全项目可引用。
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

/**
 * 信号类型。
 * 类型用途：表示交易方向与动作（买多/卖多/买空/卖空/持有），作为 Signal.action、策略输出及门禁/买卖流程的入参。
 * 数据来源：策略模块根据指标条件输出。
 * 使用范围：Signal、策略、Trader、信号处理等；全项目可引用。
 */
export type SignalType =
  | 'BUYCALL' // 买入做多
  | 'SELLCALL' // 卖出做多
  | 'BUYPUT' // 买入做空
  | 'SELLPUT' // 卖出做空
  | 'HOLD'; // 持有（不操作）

/**
 * 买入信号动作。
 * 类型用途：约束买入队列与买入处理器只能接收买入方向动作。
 * 数据来源：Signal.action 的可执行买入子集。
 * 使用范围：tradeTaskQueue、buyProcessor 等买入链路类型边界。
 */
export type BuySignalAction = 'BUYCALL' | 'BUYPUT';

/**
 * 卖出信号动作。
 * 类型用途：约束卖出队列与卖出处理器只能接收卖出方向动作。
 * 数据来源：Signal.action 的可执行卖出子集。
 * 使用范围：tradeTaskQueue、sellProcessor 等卖出链路类型边界。
 */
export type SellSignalAction = 'SELLCALL' | 'SELLPUT';

/**
 * 订单类型配置。
 * 类型用途：订单类型配置枚举（限价/增强限价/市价），作为 GlobalConfig.tradingOrderType、liquidationOrderType 及 Signal.orderTypeOverride 的类型。
 * 数据来源：配置解析（环境变量）。
 * 使用范围：配置、Trader 下单、Signal 覆盖等；全项目可引用。
 */
export type OrderTypeConfig = 'LO' | 'ELO' | 'MO';

/**
 * 交易信号。
 * 类型用途：单次交易操作的完整信息（标的、动作、原因、订单类型等），作为策略输出与执行前候选信号。
 * 数据来源：策略模块生成，经延迟验证与风控后写入。
 * 使用范围：策略、信号处理、Trader 等；全项目可引用。
 */
export type Signal = {
  /** 交易标的代码 */
  readonly symbol: string;

  /** 交易标的名称 */
  readonly symbolName: string | null;

  /** 信号动作类型 */
  readonly action: SignalType;

  /** 信号触发原因 */
  readonly reason?: string | null;

  /** 订单类型覆盖（优先级高于全局配置） */
  readonly orderTypeOverride?: OrderTypeConfig | null;

  /** 是否为保护性清仓（触发买入冷却） */
  readonly isProtectiveLiquidation?: boolean | null;

  /** 交易价格 */
  readonly price?: number | null;

  /** 每手股数 */
  readonly lotSize?: number | null;

  /** 交易数量 */
  readonly quantity?: number | null;

  /**
   * 信号触发时间
   * - 立即信号：信号生成时间
   * - 延迟信号：延迟验证的基准时间（T0）
   * - 末日保护信号：信号生成时间
   */
  readonly triggerTime?: Date | null;

  /** 信号对应的席位版本号（换标后用于丢弃旧信号） */
  readonly seatVersion?: number | null;

  /** 延迟验证：T0 时刻的指标快照 */
  readonly indicators1?: Readonly<Record<string, number>> | null;

  /** 关联的买入订单ID列表（仅卖出订单使用，用于智能平仓防重） */
  readonly relatedBuyOrderIds?: readonly string[] | null;
};

/**
 * 已绑定席位版本的交易信号。
 * 类型用途：表示已经过席位路由与版本绑定，可进入任务队列或订单执行边界的信号。
 * 数据来源：业务信号路由、延迟验证、清仓链路根据 symbolRegistry 当前席位版本补写。
 * 使用范围：任务队列 payload、异步处理器与 OrderExecutor 执行入口。
 */
type RoutedSignal = Signal & {
  readonly seatVersion: number;
};

/**
 * 买入信号。
 * 类型用途：在任务队列边界把任务类型与 Signal.action 绑定，避免买入/卖出队列串线。
 * 数据来源：普通信号流水线或延迟验证通过后的买入信号。
 * 使用范围：买入任务队列和买入处理器。
 */
export type BuySignal = RoutedSignal & {
  readonly action: BuySignalAction;
};

/**
 * 卖出信号。
 * 类型用途：在任务队列边界把任务类型与 Signal.action 绑定，避免买入/卖出队列串线。
 * 数据来源：普通信号流水线、延迟验证或保护性清仓链路生成的卖出信号。
 * 使用范围：卖出任务队列和卖出处理器。
 */
export type SellSignal = RoutedSignal & {
  readonly action: SellSignalAction;
};

/**
 * 可执行信号。
 * 类型用途：订单执行入口只接受已绑定席位版本且方向明确的买卖信号。
 * 数据来源：任务队列、保护性清仓、末日清仓、静态清仓与自动换标执行链路。
 * 使用范围：Trader.executeSignals 与 OrderExecutor.executeSignals。
 */
export type ExecutableSignal = BuySignal | SellSignal;

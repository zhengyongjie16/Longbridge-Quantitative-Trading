/**
 * 策略动作类型。
 * 类型用途：限定策略与指标画像中参与信号判定的动作集合（不含 HOLD）。
 * 数据来源：由 SignalType 收窄得到。
 * 使用范围：IndicatorUsageProfile、strategy 模块等需要按动作索引指标集合的场景。
 */
export type StrategyAction = 'BUYCALL' | 'SELLCALL' | 'BUYPUT' | 'SELLPUT';

/**
 * 指标画像中的指标名称。
 * 类型用途：统一表达运行时可计算的指标键，供展示与延迟验证等链路复用。
 * 数据来源：由 signalConfig / verificationConfig 编译生成。
 * 使用范围：IndicatorUsageProfile、strategy、delayedSignalVerifier、marketMonitor 等模块。
 */
export type ProfileIndicator =
  | 'MFI'
  | 'K'
  | 'D'
  | 'J'
  | 'MACD'
  | 'DIF'
  | 'DEA'
  | 'ADX'
  | `RSI:${number}`
  | `EMA:${number}`
  | `PSY:${number}`;

/**
 * 延迟验证支持的指标名称集合。
 * 类型用途：约束延迟验证链路可配置的指标键，避免将仅用于信号求值/展示的指标（如 RSI/MFI）误用于延迟验证。
 * 数据来源：由 verificationConfig 编译生成。
 * 使用范围：IndicatorUsageProfile.verificationIndicatorsBySide、DelayedSignalVerifier、signalPipeline 等延迟验证链路。
 */
export type VerificationIndicator =
  | 'K'
  | 'D'
  | 'J'
  | 'MACD'
  | 'DIF'
  | 'DEA'
  | 'ADX'
  | `EMA:${number}`
  | `PSY:${number}`;

/**
 * 指标展示项。
 * 类型用途：定义监控日志输出顺序中的单个展示元素，包含价格/涨跌幅与技术指标项。
 * 数据来源：由 indicatorProfile.displayPlan 编译生成。
 * 使用范围：marketMonitor 展示与变化检测。
 */
export type DisplayIndicatorItem = 'price' | 'changePercent' | ProfileIndicator;

/**
 * 监控标的指标画像。
 * 类型用途：描述单标的在运行期需要计算、校验、延迟验证和展示的指标范围，是全链路唯一输入。
 * 数据来源：monitorContext 编译阶段由 signalConfig + verificationConfig 生成。
 * 使用范围：MonitorContext、indicatorPipeline、strategy、marketMonitor、delayedSignalVerifier。
 */
export type IndicatorUsageProfile = {
  /** 指标族使用开关（族展开后） */
  readonly requiredFamilies: {
    readonly mfi: boolean;
    readonly kdj: boolean;
    readonly macd: boolean;
    readonly adx: boolean;
  };

  /** 周期指标集合（去重排序后） */
  readonly requiredPeriods: {
    readonly rsi: ReadonlyArray<number>;
    readonly ema: ReadonlyArray<number>;
    readonly psy: ReadonlyArray<number>;
  };

  /** 延迟验证按买卖方向要求存在的指标集合（与配置粒度一致） */
  readonly verificationIndicatorsBySide: {
    readonly buy: ReadonlyArray<VerificationIndicator>;
    readonly sell: ReadonlyArray<VerificationIndicator>;
  };

  /** 指标展示计划（最终展示顺序） */
  readonly displayPlan: ReadonlyArray<DisplayIndicatorItem>;
};

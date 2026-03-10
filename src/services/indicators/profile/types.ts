/**
 * 指标画像收集器。
 * 类型用途：在指标画像编译阶段累计家族开关与周期集合，供 compileIndicatorUsageProfile 及其内部流程共享。
 * 数据来源：由指标画像编译流程在运行时初始化并逐步填充。
 * 使用范围：仅 indicators/profile 子模块内部使用。
 */
export type IndicatorCollector = {
  readonly requiredFamilies: {
    mfi: boolean;
    kdj: boolean;
    macd: boolean;
    adx: boolean;
  };
  readonly requiredPeriods: {
    readonly rsi: Set<number>;
    readonly ema: Set<number>;
    readonly psy: Set<number>;
  };
};

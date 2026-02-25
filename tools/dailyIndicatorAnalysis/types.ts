import type { KDJIndicator } from '../../src/types/quote.js';

/**
 * 行着色指标键类型：用于定义可参与红绿条件判断的指标字段。
 * 数据来源：分钟指标计算结果（MinuteIndicatorRow）。
 * 使用范围：仅 `tools/dailyIndicatorAnalysis` 工具内部。
 */
export type RowColorIndicatorKey =
  | 'rsi6'
  | 'k'
  | 'd'
  | 'j'
  | 'mfi'
  | 'adx'
  | 'ema5'
  | 'poc'
  | 'vah'
  | 'val'
  | 'vaPositionInValueArea';

/**
 * 单条着色条件类型：用于描述一组「指标 -> 阈值」判断。
 * 数据来源：工具配置常量（GREEN_CONDITIONS / RED_CONDITIONS）。
 * 使用范围：仅 `tools/dailyIndicatorAnalysis` 工具内部。
 */
export type RowColorCondition = Readonly<Partial<Record<RowColorIndicatorKey, number>>>;

/**
 * 多条着色条件集合类型：任意一条条件满足即触发对应颜色。
 * 数据来源：工具配置常量（GREEN_CONDITIONS / RED_CONDITIONS）。
 * 使用范围：仅 `tools/dailyIndicatorAnalysis` 工具内部。
 */
export type RowColorConditionSet = ReadonlyArray<RowColorCondition>;

/**
 * 行着色模式类型：用于区分绿色（小于阈值）与红色（大于阈值）判断。
 * 数据来源：输出渲染阶段传入。
 * 使用范围：仅 `tools/dailyIndicatorAnalysis` 工具内部。
 */
export type RowColorMode = 'green' | 'red';

/**
 * VP（Volume Profile）结果类型：包含 POC 与价值区域上下沿。
 * 数据来源：基于分钟 K 线计算得到。
 * 使用范围：仅 `tools/dailyIndicatorAnalysis` 工具内部。
 */
export type VPResult = {
  readonly poc: number;
  readonly vah: number;
  readonly val: number;
};

/**
 * 末根 K 线变体类型：标识本行使用最高价或最低价作为收盘参与指标计算。
 * 数据来源：分钟指标推导逻辑。
 * 使用范围：仅 `tools/dailyIndicatorAnalysis` 工具内部。
 */
export type LastCandleVariant = 'high' | 'low';

/**
 * 单分钟指标行类型：每分钟输出两条（高/低），用于终端表格渲染与着色判断。
 * 数据来源：分钟 K 线与技术指标计算结果。
 * 使用范围：仅 `tools/dailyIndicatorAnalysis` 工具内部。
 */
export type MinuteIndicatorRow = {
  readonly time: string;
  readonly variant: LastCandleVariant;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly changePercent: number | null;
  readonly volume: number;
  readonly ema5: number | null;
  readonly rsi6: number | null;
  readonly kdj: KDJIndicator | null;
  readonly mfi: number | null;
  readonly adx: number | null;
  readonly vp: VPResult | null;
  readonly vaPositionInValueArea: number | null;
};

/**
 * 分钟指标计算参数类型：统一承载各指标周期与 VP 参数。
 * 数据来源：工具配置常量。
 * 使用范围：仅 `tools/dailyIndicatorAnalysis` 工具内部。
 */
export type ComputeMinuteRowsOptions = {
  readonly rsiPeriod: number;
  readonly kdjPeriod: number;
  readonly mfiPeriod: number;
  readonly adxPeriod: number;
  readonly ema5Period: number;
  readonly vpVaPercent: number;
  readonly vpBins: number;
};

/**
 * 分钟指标计算返回类型：包含当日行数据和当日日期字符串。
 * 数据来源：`computeMinuteRows` 计算函数返回。
 * 使用范围：仅 `tools/dailyIndicatorAnalysis` 工具内部。
 */
export type ComputeMinuteRowsResult = {
  readonly rows: ReadonlyArray<MinuteIndicatorRow>;
  readonly todayDate: string;
};

/**
 * 数值化 K 线类型：用于在指标计算前保存经过数值校验的 OHLCV。
 * 数据来源：LongPort Candlestick 转换后得到。
 * 使用范围：仅 `tools/dailyIndicatorAnalysis` 工具内部。
 */
export type CandleNumbers = {
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
};

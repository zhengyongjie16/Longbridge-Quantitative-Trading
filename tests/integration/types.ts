import type { TimeDriverProgramContext } from '../../src/main/timeDriverProgram/types.js';
import type { SeatState } from '../../src/types/seat.js';

/**
 * 主循环延迟测试中被延迟注入的 API 方法名。
 * 类型用途：标记启动阶段与主循环阶段的 mock API 调用来源。
 * 数据来源：由 main-loop-latency.integration.test.ts 内部 mock marketDataClient 产生。
 * 使用范围：tests/integration 下相关集成测试。
 */
export type DelayedApiMethod =
  | 'subscribeSymbols'
  | 'unsubscribeSymbols'
  | 'subscribeCandlesticks'
  | 'isTradingDay'
  | 'resetRuntimeSubscriptionsAndCaches'
  | 'getQuoteContext';

/**
 * 主循环延迟测试记录的 API 调用事件。
 * 类型用途：统计调用阶段、迭代轮次与单次耗时。
 * 数据来源：由 main-loop-latency.integration.test.ts 中的 withApiDelay 记录。
 * 使用范围：tests/integration 下相关集成测试。
 */
export type ApiCallEvent = Readonly<{
  readonly stage: 'startup' | 'main-loop';
  readonly iteration: number | null;
  readonly method: DelayedApiMethod;
  readonly elapsedMs: number;
}>;

/**
 * 主循环延迟测试的单轮指标。
 * 类型用途：记录每轮主循环耗时、API 调用数量与 API 总耗时。
 * 数据来源：由 main-loop-latency.integration.test.ts 在每轮 timeDriverProgram 执行后汇总。
 * 使用范围：tests/integration 下相关集成测试。
 */
export type IterationMetric = Readonly<{
  readonly iteration: number;
  readonly loopLatencyMs: number;
  readonly apiCallCount: number;
  readonly apiLatencyTotalMs: number;
}>;

/**
 * 多监控集成测试的 seat 快照。
 * 类型用途：维护每个 monitorSymbol 下 long/short 席位与 seatVersion。
 * 数据来源：由 main-loop-latency.integration.test.ts 构造测试内 symbolRegistry 时维护。
 * 使用范围：tests/integration 下相关集成测试。
 */
export type MultiMonitorSeatEntry = {
  longState: SeatState;
  shortState: SeatState;
  longVersion: number;
  shortVersion: number;
};

/**
 * timeDriverProgram 动态加载后的最小函数签名。
 * 类型用途：描述动态 import 返回的 timeDriverProgram 可调用契约。
 * 数据来源：由 src/main/timeDriverProgram/index.ts 导出。
 * 使用范围：tests/integration 下需要动态导入 timeDriverProgram 的测试。
 */
export interface TimeDriverProgramModule {
  readonly timeDriverProgram: (context: TimeDriverProgramContext) => Promise<void>;
}

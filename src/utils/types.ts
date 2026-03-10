import type { Quote } from '../types/quote.js';
import type { SeatState } from '../types/seat.js';

/**
 * 运行时档位类型。
 * 类型用途：表示程序当前运行环境（正式运行或测试运行），作为 runtime 解析函数的返回类型。
 * 数据来源：由环境变量解析逻辑（APP_RUNTIME_PROFILE/BUN_TEST）推导。
 * 使用范围：仅 src/utils 下的运行时与日志模块使用。
 */
export type RuntimeProfile = 'app' | 'test';

/**
 * 等待者回调函数类型。
 * 类型用途：表示在 RefreshGate 中排队等待缓存刷新完成时的回调函数签名。
 * 数据来源：由 waitForFresh() 内部创建并推入等待队列。
 * 使用范围：仅 createRefreshGate 内部使用。
 */
export type Waiter = () => void;

/**
 * 刷新门禁状态快照。
 * 类型用途：表示当前版本与过期版本号，用于协调缓存刷新与等待方。
 * 数据来源：由 RefreshGate.getStatus() 返回。
 * 使用范围：供主程序与 PostTradeRefresher 等消费 getStatus 的调用方使用。
 */
export type RefreshGateStatus = Readonly<{
  currentVersion: number;
  staleVersion: number;
}>;

/**
 * 刷新门禁接口。
 * 类型用途：依赖注入用接口，通过版本号协调缓存刷新与异步处理器时序（markStale/markFresh/waitForFresh/getStatus），供主程序与异步处理模块使用。
 * 数据来源：由 createRefreshGate 工厂实现并注入。
 * 使用范围：主程序、异步处理器、生命周期等模块可引用。
 */
export interface RefreshGate {
  readonly markStale: () => number;
  readonly markFresh: (version: number) => void;
  readonly waitForFresh: () => Promise<void>;
  readonly getStatus: () => RefreshGateStatus;
}

/**
 * 监控上下文席位快照。
 * 类型用途：统一表达从 symbolRegistry 派生出的多空席位状态、版本与当前就绪标的代码。
 * 数据来源：由 resolveMonitorContextSeatSnapshot 基于 monitorSymbol 和 symbolRegistry 计算。
 * 使用范围：app/main 共享的 MonitorContext 运行时同步逻辑使用。
 */
export type MonitorContextSeatSnapshot = Readonly<{
  seatState: {
    readonly long: SeatState;
    readonly short: SeatState;
  };
  seatVersion: {
    readonly long: number;
    readonly short: number;
  };
  longSymbol: string | null;
  shortSymbol: string | null;
}>;

/**
 * 监控上下文运行时快照。
 * 类型用途：统一表达 MonitorContext 需要写回的席位、行情与名称派生结果。
 * 数据来源：由 resolveMonitorContextRuntimeSnapshot 基于 seat 快照和 quotesMap 计算。
 * 使用范围：createMonitorContext、seatSync、rebuildTradingDayState 等同步链路使用。
 */
export type MonitorContextRuntimeSnapshot = MonitorContextSeatSnapshot &
  Readonly<{
    longQuote: Quote | null;
    shortQuote: Quote | null;
    monitorQuote: Quote | null;
    longSymbolName: string;
    shortSymbolName: string;
    monitorSymbolName: string;
  }>;

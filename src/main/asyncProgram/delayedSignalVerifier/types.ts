import type { Signal } from '../../../types/signal.js';
import type { VerificationConfig } from '../../../types/config.js';
import type { IndicatorCache } from '../indicatorCache/types.js';

/**
 * 待验证信号条目（内部队列元素）。
 * 类型用途：DelayedSignalVerifier 内部待验证队列的一项，携带信号、验证时间与定时器 ID。
 * 数据来源：由 addSignal 创建并加入内部队列，验证完成或取消时移除。
 * 使用范围：仅 delayedSignalVerifier 模块内部使用。
 */
export type PendingSignalEntry = {

  /** 待验证的信号对象 */
  readonly signal: Signal;

  /** 监控标的代码 */
  readonly monitorSymbol: string;

  /** 信号触发时间戳（毫秒） */
  readonly triggerTime: number;

  /** 计划验证时间戳（毫秒） */
  readonly verifyTime: number;

  /** 初始指标值（验证时与后续时间点比较） */
  readonly initialIndicators: Readonly<Record<string, number>>;

  /** setTimeout 定时器 ID */
  readonly timerId: ReturnType<typeof setTimeout>;
};

/**
 * 验证结果。
 * 类型用途：描述延迟信号验证的通过/拒绝状态及原因，供 performVerification 返回、executeVerification 分支使用。
 * 数据来源：由 DelayedSignalVerifier 内部 performVerification 返回。
 * 使用范围：仅 delayedSignalVerifier 模块内部使用。
 */
export type VerificationResult = {

  /** 验证是否通过 */
  readonly passed: boolean;

  /** 验证结果原因描述 */
  readonly reason: string;

  /** 未通过验证的指标名称列表 */
  readonly failedIndicators?: ReadonlyArray<string>;
};

/**
 * 验证通过回调函数类型。
 * 类型用途：延迟验证通过时由 DelayedSignalVerifier 调用，供调用方将信号推入买卖任务队列。
 * 数据来源：由主程序/processMonitor 通过 onVerified() 注册。
 * 使用范围：delayedSignalVerifier 与调用方之间契约，仅内部使用。
 */
export type VerifiedCallback = (signal: Signal, monitorSymbol: string) => void;

/**
 * DelayedSignalVerifier 依赖配置（创建验证器时的参数）。
 * 类型用途：创建 DelayedSignalVerifier 时的依赖注入对象。
 * 数据来源：由主程序/启动流程组装（indicatorCache、verificationConfig）并传入工厂。
 * 使用范围：仅创建 DelayedSignalVerifier 的调用方使用，内部使用。
 */
export type DelayedSignalVerifierDeps = {
  readonly indicatorCache: IndicatorCache;
  readonly verificationConfig: VerificationConfig;
};

/**
 * DelayedSignalVerifier 行为契约。
 * 类型用途：延迟买入/卖出信号的 T+N 验证（addSignal/cancelAll/getPendingCount/onVerified 等），由主程序按监控标的创建。
 * 数据来源：主程序通过工厂创建并注入 processMonitor；待验证信号由信号流水线经 addSignal 入队。
 * 使用范围：mainProgram、processMonitor 等使用，仅内部使用。
 */
export interface DelayedSignalVerifier {

  /**
   * 添加信号到待验证队列
   * @param signal 信号对象（必须包含 triggerTime）
   * @param monitorSymbol 监控标的代码
   */
  addSignal: (signal: Signal, monitorSymbol: string) => void;

  /**
   * 取消指定标的的所有待验证信号
   * @param monitorSymbol 监控标的代码
   */
  cancelAllForSymbol: (monitorSymbol: string) => void;

  /**
   * 取消指定方向的待验证信号
   * @param monitorSymbol 监控标的代码
   * @param direction 多空方向（由信号动作判定）
   * @returns 已取消的信号数量
   */
  cancelAllForDirection: (monitorSymbol: string, direction: 'LONG' | 'SHORT') => number;

  /**
   * 取消所有待验证信号（清理定时器并释放信号）
   * @returns 已取消的信号数量
   */
  cancelAll: () => number;

  /**
   * 获取待验证信号数量
   */
  getPendingCount: () => number;

  /**
   * 注册验证通过回调
   * @param callback 验证通过时调用
   */
  onVerified: (callback: VerifiedCallback) => void;

  /**
   * 销毁验证器，清理所有定时器和资源
   */
  destroy: () => void;
}

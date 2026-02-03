/**
 * DelayedSignalVerifier 模块类型定义
 *
 * 延迟信号验证器使用 setTimeout 自行计时，在信号触发后延迟一段时间
 * 验证指标趋势是否持续，确保信号的有效性。
 */

import type { Signal, VerificationConfig } from '../../../types/index.js';
import type { IndicatorCache } from '../indicatorCache/types.js';

/**
 * 待验证信号条目
 *
 * 存储信号及其验证所需的上下文信息
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
 * 验证结果
 */
export type VerificationResult = {
  /** 验证是否通过 */
  readonly passed: boolean;
  /** 验证结果原因描述 */
  readonly reason: string;
  /** 未通过验证的指标名称列表 */
  readonly failedIndicators?: ReadonlyArray<string>;
};

/** 验证通过回调函数类型 */
export type VerifiedCallback = (signal: Signal, monitorSymbol: string) => void;
/** 验证拒绝回调函数类型 */
export type RejectedCallback = (signal: Signal, monitorSymbol: string, reason: string) => void;

/**
 * DelayedSignalVerifier 依赖配置
 */
export type DelayedSignalVerifierDeps = {
  readonly indicatorCache: IndicatorCache;
  readonly verificationConfig: VerificationConfig;
};

/**
 * DelayedSignalVerifier 行为契约
 */
export interface DelayedSignalVerifier {
  /**
   * 添加信号到待验证队列
   * @param signal 信号对象（必须包含 triggerTime）
   * @param monitorSymbol 监控标的代码
   */
  addSignal(signal: Signal, monitorSymbol: string): void;

  /**
   * 取消指定信号的验证
   * @param signalId 信号ID（格式：symbol:action:triggerTime）
   * @returns 是否成功取消
   */
  cancelSignal(signalId: string): boolean;

  /**
   * 取消指定标的的所有待验证信号
   * @param monitorSymbol 监控标的代码
   */
  cancelAllForSymbol(monitorSymbol: string): void;

  /**
   * 取消指定方向的待验证信号
   * @param monitorSymbol 监控标的代码
   * @param direction 多空方向（由信号动作判定）
   * @returns 已取消的信号数量
   */
  cancelAllForDirection(monitorSymbol: string, direction: 'LONG' | 'SHORT'): number;

  /**
   * 获取待验证信号数量
   */
  getPendingCount(): number;

  /**
   * 注册验证通过回调
   * @param callback 验证通过时调用
   */
  onVerified(callback: VerifiedCallback): void;

  /**
   * 注册验证拒绝回调
   * @param callback 验证拒绝时调用
   */
  onRejected(callback: RejectedCallback): void;

  /**
   * 销毁验证器，清理所有定时器和资源
   */
  destroy(): void;
}

/**
 * monitor context 行为端口模块
 *
 * 职责：
 * - 定义 MonitorContext 暴露给调用方的共享行为契约
 * - 作为 types/app/services/main 之间的单一行为边界来源，避免重复同义接口
 */
import type { Position } from './account.js';
import type { VerificationIndicator } from './indicatorProfile.js';
import type { Signal } from './signal.js';

/**
 * 距离换标等待唤醒描述。
 * 类型用途：显式表达 pending switch 下一次需要等待的事件源。
 * 数据来源：由 autoSymbolManager 状态机单步推进结果生成。
 * 使用范围：types、app、main、services 与相关测试使用。
 */
export type SwitchWakeupRequirement =
  | Readonly<{
      kind: 'ORDER_EVENT';
      symbols: ReadonlyArray<string>;
    }>
  | Readonly<{
      kind: 'FRESHNESS';
    }>
  | Readonly<{
      kind: 'SYMBOL_QUOTE';
      symbol: string;
    }>
  | Readonly<{
      kind: 'RETRY_TIMER';
      atMs: number;
    }>;

/**
 * 距离换标单步推进结果。
 * 类型用途：显式表达本轮推进后已完成、无需动作，或下一次需要等待的事件源。
 * 数据来源：由 autoSymbolManager 状态机单步推进返回。
 * 使用范围：types、app、main、services 与相关测试使用。
 */
export type SwitchDriveResult =
  | Readonly<{
      kind: 'NOOP';
    }>
  | Readonly<{
      kind: 'COMPLETED';
    }>
  | Readonly<{
      kind: 'FAILED';
      reason: string;
    }>
  | Readonly<{
      kind: 'WAIT';
      wakeups: ReadonlyArray<SwitchWakeupRequirement>;
    }>;

/**
 * 距回收价换标启动结果。
 * 类型用途：显式表达本轮是否真正启动换标，以及启动后得到的下一步唤醒需求。
 * 数据来源：由 autoSymbolManager.startSwitchOnDistance 返回。
 * 使用范围：types、app、main、services 与相关测试使用。
 */
export type StartSwitchOnDistanceResult =
  | Readonly<{
      started: false;
      direction: 'LONG' | 'SHORT';
      driveResult: Extract<SwitchDriveResult, { kind: 'NOOP' }>;
    }>
  | Readonly<{
      started: true;
      direction: 'LONG' | 'SHORT';
      driveResult: Exclude<SwitchDriveResult, { kind: 'NOOP' }>;
    }>;

/**
 * 距回收价 pending switch 推进结果。
 * 类型用途：显式表达本轮是否真正执行了推进；未推进时只能返回 NOOP，已推进时携带状态机单步结果。
 * 数据来源：由 autoSymbolManager.advancePendingSwitch 返回。
 * 使用范围：types、app、main、services 与相关测试使用。
 */
export type AdvancePendingSwitchResult =
  | Readonly<{
      advanced: false;
      direction: 'LONG' | 'SHORT';
      stillPending: false;
      driveResult: Extract<SwitchDriveResult, { kind: 'NOOP' }>;
    }>
  | Readonly<{
      advanced: true;
      direction: 'LONG' | 'SHORT';
      stillPending: boolean;
      driveResult: SwitchDriveResult;
    }>;

/**
 * 自动换标管理器行为契约。
 * 类型用途：约束 MonitorContext.autoSymbolManager 的可调用方法。
 * 数据来源：由 autoSymbolManager 模块实现并注入。
 * 使用范围：types、app、main、services 与相关测试使用。
 */
export interface AutoSymbolManagerPort {
  maybeSearchOnEvent: (params: {
    readonly direction: 'LONG' | 'SHORT';
    readonly currentTime: Date;
    readonly canTradeNow: boolean;
  }) => Promise<void>;
  maybeSwitchOnInterval: (params: {
    readonly direction: 'LONG' | 'SHORT';
    readonly currentTime: Date;
    readonly canTradeNow: boolean;
  }) => Promise<SwitchDriveResult>;
  startSwitchOnDistance: (params: {
    readonly direction: 'LONG' | 'SHORT';
    readonly monitorPrice: number | null;
    readonly positions: ReadonlyArray<Position>;
  }) => Promise<StartSwitchOnDistanceResult>;
  advancePendingSwitch: (params: {
    readonly direction: 'LONG' | 'SHORT';
    readonly positions: ReadonlyArray<Position>;
  }) => Promise<AdvancePendingSwitchResult>;
  hasPendingSwitch: (direction: 'LONG' | 'SHORT') => boolean;
  resetAllState: () => void;
}

/**
 * 延迟信号验证器行为契约。
 * 类型用途：约束 MonitorContext.delayedSignalVerifier 的生命周期与队列操作方法。
 * 数据来源：由 delayedSignalVerifier 模块实现并注入。
 * 使用范围：types、app、main 与相关测试使用。
 */
export interface DelayedSignalVerifierPort {
  addSignal: (params: {
    readonly signal: Signal;
    readonly monitorSymbol: string;
    readonly verificationIndicators: ReadonlyArray<VerificationIndicator>;
  }) => void;
  onVerified: (callback: (signal: Signal, monitorSymbol: string) => void) => void;
  cancelAll: () => number;
  cancelAllForSymbol: (monitorSymbol: string) => void;
  cancelAllForDirection: (monitorSymbol: string, direction: 'LONG' | 'SHORT') => number;
  getPendingCount: () => number;
  destroy: () => void;
}

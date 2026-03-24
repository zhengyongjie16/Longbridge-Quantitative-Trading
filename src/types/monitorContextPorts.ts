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
 * 自动换标管理器行为契约。
 * 类型用途：约束 MonitorContext.autoSymbolManager 的可调用方法。
 * 数据来源：由 autoSymbolManager 模块实现并注入。
 * 使用范围：types、app、main、services 与相关测试使用。
 */
export interface AutoSymbolManagerPort {
  maybeSearchOnTick: (params: {
    readonly direction: 'LONG' | 'SHORT';
    readonly currentTime: Date;
    readonly canTradeNow: boolean;
  }) => Promise<void>;
  maybeSwitchOnInterval: (params: {
    readonly direction: 'LONG' | 'SHORT';
    readonly currentTime: Date;
    readonly canTradeNow: boolean;
    readonly openProtectionActive: boolean;
  }) => Promise<void>;
  maybeSwitchOnDistance: (params: {
    readonly direction: 'LONG' | 'SHORT';
    readonly monitorPrice: number | null;
    readonly positions: ReadonlyArray<Position>;
  }) => Promise<void>;
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

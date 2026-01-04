/**
 * 策略模块类型定义
 */

import type { SignalConfigSet, VerificationConfig } from '../../types/index.js';
import type { Signal } from '../../types/index.js';

/**
 * 策略配置接口
 */
export interface StrategyConfig {
  signalConfig?: SignalConfigSet | null;
  verificationConfig?: VerificationConfig;
}

/**
 * 信号生成结果接口
 */
export interface SignalGenerationResult {
  immediateSignals: Signal[];
  delayedSignals: Signal[];
}


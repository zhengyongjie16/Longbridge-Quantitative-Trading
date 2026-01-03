/**
 * 配置类型定义
 */

import { SignalConfig } from './core.js';

/**
 * 交易配置
 */
export type TradingConfig = {
  readonly monitorSymbol: string | null;
  readonly longSymbol: string | null;
  readonly shortSymbol: string | null;
  readonly targetNotional: number | null;
  readonly longLotSize: number | null;
  readonly shortLotSize: number | null;
  readonly maxPositionNotional: number | null;
  readonly maxDailyLoss: number | null;
  readonly maxUnrealizedLossPerSymbol: number | null;
  readonly doomsdayProtection: boolean;
  readonly buyIntervalSeconds: number;
  readonly verificationConfig: VerificationConfig;
  readonly signalConfig: SignalConfigSet;
};

/**
 * 验证配置
 */
export type VerificationConfig = {
  readonly delaySeconds: number;
  readonly indicators: ReadonlyArray<string> | null;
};

/**
 * 信号配置集
 */
export type SignalConfigSet = {
  readonly buycall: SignalConfig | null;
  readonly sellcall: SignalConfig | null;
  readonly buyput: SignalConfig | null;
  readonly sellput: SignalConfig | null;
};

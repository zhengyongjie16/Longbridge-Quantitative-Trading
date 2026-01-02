/**
 * 配置类型定义
 */

import { SignalConfig } from './core.js';

export interface TradingConfig {
  monitorSymbol: string | null;
  longSymbol: string | null;
  shortSymbol: string | null;
  targetNotional: number | null;
  longLotSize: number | null;
  shortLotSize: number | null;
  maxPositionNotional: number | null;
  maxDailyLoss: number | null;
  maxUnrealizedLossPerSymbol: number | null;
  doomsdayProtection: boolean;
  buyIntervalSeconds: number;
  verificationConfig: VerificationConfig;
  signalConfig: SignalConfigSet;
}

export interface VerificationConfig {
  delaySeconds: number;
  indicators: string[] | null;
}

export interface SignalConfigSet {
  buycall: SignalConfig | null;
  sellcall: SignalConfig | null;
  buyput: SignalConfig | null;
  sellput: SignalConfig | null;
}

export interface ApiConfig {
  appKey: string;
  appSecret: string;
  accessToken: string;
  httpUrl?: string;
  quoteWsUrl?: string;
  tradeWsUrl?: string;
}

export interface EnvConfig {
  debug: boolean;
  logLevel: string;
}

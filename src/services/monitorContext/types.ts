import type {
  MonitorConfig,
  MonitorContext,
  MonitorState,
  OrderRecorder,
  Quote,
  RiskChecker,
  SymbolRegistry,
} from '../../types/index.js';
import type { HangSengMultiIndicatorStrategy } from '../../core/strategy/types.js';
import type { UnrealizedLossMonitor } from '../../core/unrealizedLossMonitor/types.js';
import type { DelayedSignalVerifier } from '../../main/asyncProgram/delayedSignalVerifier/types.js';
import type { AutoSymbolManager } from '../autoSymbolManager/types.js';

export type MonitorContextFactoryDeps = {
  readonly config: MonitorConfig;
  readonly state: MonitorState;
  readonly symbolRegistry: SymbolRegistry;
  readonly quotesMap: ReadonlyMap<string, Quote | null>;
  readonly strategy: HangSengMultiIndicatorStrategy;
  readonly orderRecorder: OrderRecorder;
  readonly riskChecker: RiskChecker;
  readonly unrealizedLossMonitor: UnrealizedLossMonitor;
  readonly delayedSignalVerifier: DelayedSignalVerifier;
  readonly autoSymbolManager: AutoSymbolManager;
};

export type MonitorContextFactory = (deps: MonitorContextFactoryDeps) => MonitorContext;

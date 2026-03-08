/**
 * Legacy State Facade
 *
 * 职责：
 * - 将新 runtime stores 投影为旧 LastState / MonitorContext 形态
 * - 在阶段 1 保持旧调用链不变，同时把真相源切到 stores
 */
import type { MonitorConfig } from '../../types/config.js';
import type { Quote } from '../../types/quote.js';
import type { SymbolRegistry } from '../../types/seat.js';
import type { LastState, MonitorContext } from '../../types/state.js';
import type { OrderRecorder, RiskChecker } from '../../types/services.js';
import type { HangSengMultiIndicatorStrategy } from '../../core/strategy/types.js';
import type {
  DailyLossTracker,
  UnrealizedLossMonitor,
} from '../../core/riskController/types.js';
import type { DelayedSignalVerifier } from '../../main/asyncProgram/delayedSignalVerifier/types.js';
import type { AutoSymbolManager } from '../../services/autoSymbolManager/types.js';
import type {
  MarketDataRuntimeStore,
  MonitorRuntimeEntry,
  MonitorRuntimeStore,
  SystemRuntimeStateStore,
  TradingDayReadModelStore,
} from './types.js';

function defineForwardedProperty<TValue>(params: {
  readonly target: object;
  readonly key: string;
  readonly getValue: () => TValue;
  readonly setValue: (value: TValue) => void;
}): void {
  const { target, key, getValue, setValue } = params;
  Object.defineProperty(target, key, {
    enumerable: true,
    configurable: false,
    get: getValue,
    set: setValue,
  });
}

/**
 * 创建 legacy LastState facade。
 *
 * @param params 新 runtime stores
 * @returns 兼容旧调用链的 LastState 对象
 */
export function createLegacyLastStateFacade(params: {
  readonly systemRuntimeStateStore: SystemRuntimeStateStore;
  readonly tradingDayReadModelStore: TradingDayReadModelStore;
  readonly monitorRuntimeStore: MonitorRuntimeStore;
  readonly marketDataRuntimeStore: MarketDataRuntimeStore;
}): LastState {
  const {
    systemRuntimeStateStore,
    tradingDayReadModelStore,
    monitorRuntimeStore,
    marketDataRuntimeStore,
  } = params;
  const facade = {
    positionCache: systemRuntimeStateStore.getState().positionCache,
    monitorStates: monitorRuntimeStore.getState().monitorStates,
  } as unknown as LastState;

  defineForwardedProperty({
    target: facade,
    key: 'canTrade',
    getValue: () => systemRuntimeStateStore.getState().canTrade,
    setValue: (value: LastState['canTrade']) => {
      systemRuntimeStateStore.setCanTrade(value);
    },
  });

  defineForwardedProperty({
    target: facade,
    key: 'isHalfDay',
    getValue: () => systemRuntimeStateStore.getState().isHalfDay,
    setValue: (value: LastState['isHalfDay']) => {
      systemRuntimeStateStore.setIsHalfDay(value);
    },
  });

  defineForwardedProperty({
    target: facade,
    key: 'openProtectionActive',
    getValue: () => systemRuntimeStateStore.getState().openProtectionActive,
    setValue: (value: LastState['openProtectionActive']) => {
      systemRuntimeStateStore.setOpenProtectionActive(value);
    },
  });

  defineForwardedProperty({
    target: facade,
    key: 'currentDayKey',
    getValue: () => systemRuntimeStateStore.getState().currentDayKey,
    setValue: (value: LastState['currentDayKey']) => {
      systemRuntimeStateStore.setCurrentDayKey(value);
    },
  });

  defineForwardedProperty({
    target: facade,
    key: 'lifecycleState',
    getValue: () => systemRuntimeStateStore.getState().lifecycleState,
    setValue: (value: LastState['lifecycleState']) => {
      systemRuntimeStateStore.setLifecycleState(value);
    },
  });

  defineForwardedProperty({
    target: facade,
    key: 'pendingOpenRebuild',
    getValue: () => systemRuntimeStateStore.getState().pendingOpenRebuild,
    setValue: (value: LastState['pendingOpenRebuild']) => {
      systemRuntimeStateStore.setPendingOpenRebuild(value);
    },
  });

  defineForwardedProperty({
    target: facade,
    key: 'targetTradingDayKey',
    getValue: () => systemRuntimeStateStore.getState().targetTradingDayKey,
    setValue: (value: LastState['targetTradingDayKey']) => {
      systemRuntimeStateStore.setTargetTradingDayKey(value);
    },
  });

  defineForwardedProperty({
    target: facade,
    key: 'isTradingEnabled',
    getValue: () => systemRuntimeStateStore.getState().isTradingEnabled,
    setValue: (value: LastState['isTradingEnabled']) => {
      systemRuntimeStateStore.setIsTradingEnabled(value);
    },
  });

  defineForwardedProperty({
    target: facade,
    key: 'cachedAccount',
    getValue: () => systemRuntimeStateStore.getState().cachedAccount,
    setValue: (value: LastState['cachedAccount']) => {
      systemRuntimeStateStore.setCachedAccount(value);
    },
  });

  defineForwardedProperty({
    target: facade,
    key: 'cachedPositions',
    getValue: () => systemRuntimeStateStore.getState().cachedPositions,
    setValue: (value: LastState['cachedPositions']) => {
      systemRuntimeStateStore.setCachedPositions(value);
    },
  });

  defineForwardedProperty({
    target: facade,
    key: 'cachedTradingDayInfo',
    getValue: () => tradingDayReadModelStore.getState().cachedTradingDayInfo,
    setValue: (value: LastState['cachedTradingDayInfo']) => {
      tradingDayReadModelStore.setCachedTradingDayInfo(value);
    },
  });

  defineForwardedProperty({
    target: facade,
    key: 'tradingCalendarSnapshot',
    getValue: () => tradingDayReadModelStore.getState().tradingCalendarSnapshot,
    setValue: (value: LastState['tradingCalendarSnapshot']) => {
      tradingDayReadModelStore.setTradingCalendarSnapshot(value ?? new Map());
    },
  });

  defineForwardedProperty({
    target: facade,
    key: 'allTradingSymbols',
    getValue: () => marketDataRuntimeStore.getState().activeTradingSymbols,
    setValue: (value: LastState['allTradingSymbols']) => {
      marketDataRuntimeStore.replaceActiveTradingSymbols(value);
    },
  });

  return facade;
}

/**
 * 创建 legacy MonitorContext facade。
 *
 * @param params 静态依赖与 monitor runtime entry
 * @returns 兼容旧调用链的 MonitorContext 对象
 */
export function createLegacyMonitorContextFacade(params: {
  readonly config: MonitorConfig;
  readonly symbolRegistry: SymbolRegistry;
  readonly autoSymbolManager: AutoSymbolManager;
  readonly strategy: HangSengMultiIndicatorStrategy;
  readonly orderRecorder: OrderRecorder;
  readonly dailyLossTracker: DailyLossTracker;
  readonly riskChecker: RiskChecker;
  readonly unrealizedLossMonitor: UnrealizedLossMonitor;
  readonly delayedSignalVerifier: DelayedSignalVerifier;
  readonly runtimeEntry: MonitorRuntimeEntry;
}): MonitorContext {
  const {
    config,
    symbolRegistry,
    autoSymbolManager,
    strategy,
    orderRecorder,
    dailyLossTracker,
    riskChecker,
    unrealizedLossMonitor,
    delayedSignalVerifier,
    runtimeEntry,
  } = params;
  const facade = {
    config,
    state: runtimeEntry.state,
    symbolRegistry,
    autoSymbolManager,
    strategy,
    orderRecorder,
    dailyLossTracker,
    riskChecker,
    unrealizedLossMonitor,
    delayedSignalVerifier,
    normalizedMonitorSymbol: runtimeEntry.normalizedMonitorSymbol,
    indicatorProfile: runtimeEntry.indicatorProfile,
  } as MonitorContext;

  defineForwardedProperty({
    target: facade,
    key: 'seatState',
    getValue: () => runtimeEntry.seatState,
    setValue: (value: MonitorContext['seatState']) => {
      runtimeEntry.seatState = value;
    },
  });

  defineForwardedProperty({
    target: facade,
    key: 'seatVersion',
    getValue: () => runtimeEntry.seatVersion,
    setValue: (value: MonitorContext['seatVersion']) => {
      runtimeEntry.seatVersion = value;
    },
  });

  defineForwardedProperty({
    target: facade,
    key: 'longSymbolName',
    getValue: () => runtimeEntry.longSymbolName,
    setValue: (value: string) => {
      runtimeEntry.longSymbolName = value;
    },
  });

  defineForwardedProperty({
    target: facade,
    key: 'shortSymbolName',
    getValue: () => runtimeEntry.shortSymbolName,
    setValue: (value: string) => {
      runtimeEntry.shortSymbolName = value;
    },
  });

  defineForwardedProperty({
    target: facade,
    key: 'monitorSymbolName',
    getValue: () => runtimeEntry.monitorSymbolName,
    setValue: (value: string) => {
      runtimeEntry.monitorSymbolName = value;
    },
  });

  defineForwardedProperty({
    target: facade,
    key: 'longQuote',
    getValue: () => runtimeEntry.longQuote,
    setValue: (value: Quote | null) => {
      runtimeEntry.longQuote = value;
    },
  });

  defineForwardedProperty({
    target: facade,
    key: 'shortQuote',
    getValue: () => runtimeEntry.shortQuote,
    setValue: (value: Quote | null) => {
      runtimeEntry.shortQuote = value;
    },
  });

  defineForwardedProperty({
    target: facade,
    key: 'monitorQuote',
    getValue: () => runtimeEntry.monitorQuote,
    setValue: (value: Quote | null) => {
      runtimeEntry.monitorQuote = value;
    },
  });

  return facade;
}

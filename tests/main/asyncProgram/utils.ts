/**
 * asyncProgram 业务测试共用工具
 *
 * 供 sellProcessor、buyProcessor、monitorTaskProcessor 等测试使用。
 * 场景函数命名：run* / assert*；工厂用 create 前缀。
 */
import type { LastState, MonitorContext } from '../../../src/types/state.js';
import {
  createMonitorConfigDouble,
  createOrderRecorderDouble,
  createPositionCacheDouble,
  createPositionDouble,
  createQuoteDouble,
  createRiskCheckerDouble,
  createSymbolRegistryDouble,
} from '../../helpers/testDoubles.js';

/**
 * 轮询直到条件为 true 或超时。默认行为：超时抛错。
 *
 * @param predicate 条件函数
 * @param timeoutMs 超时毫秒数
 * @returns 无返回值，超时抛出 Error
 */
export async function waitUntil(predicate: () => boolean, timeoutMs: number = 800): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('waitUntil timeout');
    }
    await Bun.sleep(10);
  }
}

/**
 * runProcessorFlow 入参。
 * 类型用途：测试中启动处理器、推送任务、等待条件并排空的参数聚合。
 * 使用范围：仅 tests/main/asyncProgram 使用。
 */
export type RunProcessorFlowParams = {
  readonly processor: { start: () => void; stopAndDrain: () => Promise<void> };
  readonly pushTask: () => void;
  readonly waitCondition: () => boolean;
  readonly timeoutMs?: number;
};

/**
 * 启动处理器、推送任务、等待条件满足后 stopAndDrain。用于测试异步队列消费流程。
 *
 * @param params.processor 处理器实例（start、stopAndDrain）
 * @param params.pushTask 推送任务的函数
 * @param params.waitCondition 满足即认为任务已处理的条件
 * @param params.timeoutMs 可选超时毫秒数，默认 800
 * @returns 无返回值，超时由 waitUntil 抛错
 */
export async function runProcessorFlow(params: RunProcessorFlowParams): Promise<void> {
  const { processor, pushTask, waitCondition, timeoutMs = 800 } = params;
  processor.start();
  pushTask();
  await waitUntil(waitCondition, timeoutMs);
  await processor.stopAndDrain();
}

/**
 * 构造 LastState 测试数据。默认行为：未传字段使用可交易、非半日市等默认值。
 *
 * @param overrides 覆盖字段（可选）
 * @returns 用于测试的 LastState
 */
export function createLastState(overrides: Partial<LastState> = {}): LastState {
  return {
    canTrade: true,
    isHalfDay: false,
    openProtectionActive: false,
    currentDayKey: '2026-02-16',
    lifecycleState: 'ACTIVE',
    pendingOpenRebuild: false,
    targetTradingDayKey: null,
    isTradingEnabled: true,
    cachedAccount: null,
    cachedPositions: [],
    positionCache: createPositionCacheDouble(),
    cachedTradingDayInfo: null,
    monitorStates: new Map(),
    allTradingSymbols: new Set(),
    ...overrides,
  };
}

type MonitorContextBaseOptions = Readonly<{
  state: MonitorContext['state'];
  longQuote: MonitorContext['longQuote'];
  shortQuote: MonitorContext['shortQuote'];
  monitorQuote: MonitorContext['monitorQuote'];
  monitorSymbolName: string;
}>;

function buildMonitorContextBase(
  options: MonitorContextBaseOptions,
  overrides: Partial<MonitorContext>,
): MonitorContext {
  const { state, longQuote, shortQuote, monitorQuote, monitorSymbolName } = options;
  const symbolRegistry = createSymbolRegistryDouble({
    monitorSymbol: 'HSI.HK',
    longVersion: 2,
    shortVersion: 3,
  });
  return {
    config: createMonitorConfigDouble(),
    state,
    symbolRegistry,
    seatState: {
      long: symbolRegistry.getSeatState('HSI.HK', 'LONG'),
      short: symbolRegistry.getSeatState('HSI.HK', 'SHORT'),
    },
    seatVersion: {
      long: symbolRegistry.getSeatVersion('HSI.HK', 'LONG'),
      short: symbolRegistry.getSeatVersion('HSI.HK', 'SHORT'),
    },
    autoSymbolManager: {
      maybeSearchOnTick: async () => {},
      maybeSwitchOnInterval: async () => {},
      maybeSwitchOnDistance: async () => {},
      hasPendingSwitch: () => false,
      resetAllState: () => {},
    },
    strategy: {
      generateCloseSignals: () => ({ immediateSignals: [], delayedSignals: [] }),
    },
    orderRecorder: createOrderRecorderDouble(),
    dailyLossTracker: {
      resetAll: () => {},
      recalculateFromAllOrders: () => {},
      recordFilledOrder: () => {},
      getLossOffset: () => 0,
    },
    riskChecker: createRiskCheckerDouble(),
    unrealizedLossMonitor: {
      monitorUnrealizedLoss: async () => {},
    },
    delayedSignalVerifier: {
      addSignal: () => {},
      cancelAllForSymbol: () => {},
      cancelAllForDirection: () => 0,
      cancelAll: () => 0,
      getPendingCount: () => 0,
      onVerified: () => {},
      destroy: () => {},
    },
    longSymbolName: 'BULL.HK',
    shortSymbolName: 'BEAR.HK',
    monitorSymbolName,
    normalizedMonitorSymbol: 'HSI.HK',
    rsiPeriods: [6],
    emaPeriods: [7],
    psyPeriods: [13],
    longQuote,
    shortQuote,
    monitorQuote,
    ...overrides,
  } as unknown as MonitorContext;
}

/**
 * 构造带默认行情与席位的 MonitorContext，供 buyProcessor/sellProcessor 测试使用。
 *
 * @param overrides 覆盖字段（可选）
 * @returns 用于测试的 MonitorContext
 */
export function createMonitorContext(overrides: Partial<MonitorContext> = {}): MonitorContext {
  return buildMonitorContextBase(
    {
      state: {
        monitorSymbol: 'HSI.HK',
        monitorPrice: 20_000,
        longPrice: 1.1,
        shortPrice: 0.9,
        signal: null,
        pendingDelayedSignals: [],
        monitorValues: null,
        lastMonitorSnapshot: null,
        lastCandleFingerprint: null,
      },
      longQuote: createQuoteDouble('BULL.HK', 1.1, 100),
      shortQuote: createQuoteDouble('BEAR.HK', 0.9, 100),
      monitorQuote: createQuoteDouble('HSI.HK', 20_000, 1),
      monitorSymbolName: 'HSI.HK',
    },
    overrides,
  );
}

/**
 * 构造带 BULL.HK/BEAR.HK 持仓的 LastState，供卖出流程等测试使用。
 *
 * @returns 含 positionCache 与 cachedPositions 的 LastState
 */
export function createLastStateWithPositions(): LastState {
  const positions = [
    createPositionDouble({ symbol: 'BULL.HK', quantity: 500, availableQuantity: 500 }),
    createPositionDouble({ symbol: 'BEAR.HK', quantity: 300, availableQuantity: 300 }),
  ];
  return createLastState({
    cachedPositions: positions,
    positionCache: createPositionCacheDouble(positions),
  });
}

/**
 * 构造无行情、无席位的 MonitorContext，供 monitorTaskProcessor 等测试使用。
 *
 * @param overrides 覆盖字段（可选）
 * @returns 用于监控任务测试的 MonitorContext
 */
export function createMonitorTaskContext(overrides: Partial<MonitorContext> = {}): MonitorContext {
  return buildMonitorContextBase(
    {
      state: {
        monitorSymbol: 'HSI.HK',
        monitorPrice: null,
        longPrice: null,
        shortPrice: null,
        signal: null,
        pendingDelayedSignals: [],
        monitorValues: null,
        lastMonitorSnapshot: null,
        lastCandleFingerprint: null,
      },
      longQuote: null,
      shortQuote: null,
      monitorQuote: null,
      monitorSymbolName: 'HSI',
    },
    overrides,
  );
}

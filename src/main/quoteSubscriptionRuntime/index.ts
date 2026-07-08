/**
 * QuoteSubscriptionRuntime
 *
 * 职责：
 * - 作为稳态运行期 quote 订阅集合唯一 owner
 * - 以 retain reason 汇总 monitor、seat、position、order 与临时等待需求
 * - 串行执行 subscribe/unsubscribe mutation，并在提交成功后更新 committed set 与 lastState.allTradingSymbols
 */
import type { Position } from '../../types/account.js';
import type { SeatStateChangedEvent } from '../../types/seat.js';
import type { OrderHoldSymbolsChangedEvent, Unsubscribe } from '../../types/services.js';
import { formatError } from '../../utils/error/index.js';
import { logger } from '../../utils/logger/index.js';
import type {
  MutableQuoteSubscriptionRetainStore,
  QuoteSubscriptionRetainParams,
  QuoteSubscriptionRetainOwner,
  QuoteSubscriptionRuntime,
  QuoteSubscriptionRuntimeDeps,
} from './types.js';

function buildOwnerStoreKey(owner: QuoteSubscriptionRetainOwner): string {
  return `${owner.reason}:${owner.ownerKey}`;
}

function normalizeSymbols(symbols: Iterable<string>): ReadonlyArray<string> {
  return [...new Set([...symbols].filter((symbol) => symbol.length > 0))];
}

function collectPositionSymbols(positions: ReadonlyArray<Position>): ReadonlyArray<string> {
  return normalizeSymbols(positions.map((position) => position.symbol));
}

function collectSeatSymbols(event: SeatStateChangedEvent): ReadonlyArray<string> {
  return normalizeSymbols([event.previousState.symbol ?? '', event.nextState.symbol ?? '']);
}

function hasRetainForSymbol(
  retainsByOwner: ReadonlyMap<string, ReadonlySet<string>>,
  symbol: string,
): boolean {
  for (const symbols of retainsByOwner.values()) {
    if (symbols.has(symbol)) {
      return true;
    }
  }

  return false;
}

/**
 * 创建 quote 订阅 runtime。
 * runtime 不复制业务事实，只在事件到达时从权威状态重投影对应 retain reason。
 *
 * @param deps 运行期依赖
 * @returns QuoteSubscriptionRuntime 实例
 */
export function createQuoteSubscriptionRuntime(
  deps: QuoteSubscriptionRuntimeDeps,
): QuoteSubscriptionRuntime {
  let running = false;
  let mutationChain: Promise<void> = Promise.resolve();
  let unsubscribeSeatStateChanged: Unsubscribe | null = null;
  let unsubscribeOrderHoldChanged: Unsubscribe | null = null;
  const retainsByOwner: MutableQuoteSubscriptionRetainStore = new Map();

  function readCommittedSymbolsFromLastState(): Set<string> {
    return new Set(deps.lastState.allTradingSymbols);
  }

  function setOwnerSymbols(owner: QuoteSubscriptionRetainOwner, symbols: Iterable<string>): void {
    const normalized = normalizeSymbols(symbols);
    const ownerStoreKey = buildOwnerStoreKey(owner);
    if (normalized.length === 0) {
      retainsByOwner.delete(ownerStoreKey);
      return;
    }

    retainsByOwner.set(ownerStoreKey, new Set(normalized));
  }

  function removeOwner(owner: QuoteSubscriptionRetainOwner): void {
    retainsByOwner.delete(buildOwnerStoreKey(owner));
  }

  function collectDesiredSymbols(): Set<string> {
    const desired = new Set<string>();
    for (const symbols of retainsByOwner.values()) {
      for (const symbol of symbols) {
        desired.add(symbol);
      }
    }

    return desired;
  }

  async function applyMutation(): Promise<void> {
    const desired = collectDesiredSymbols();
    const committedSymbols = readCommittedSymbolsFromLastState();
    const added = [...desired].filter((symbol) => !committedSymbols.has(symbol));
    const removed = [...committedSymbols].filter((symbol) => !desired.has(symbol));

    if (added.length > 0) {
      await deps.marketDataClient.subscribeSymbols(added);
      for (const symbol of added) {
        committedSymbols.add(symbol);
      }
    }

    if (removed.length > 0) {
      await deps.marketDataClient.unsubscribeSymbols(removed);
      for (const symbol of removed) {
        committedSymbols.delete(symbol);
      }
    }

    deps.lastState.allTradingSymbols = new Set(committedSymbols);
  }

  function enqueueMutation(): Promise<void> {
    mutationChain = mutationChain.then(applyMutation, applyMutation);
    return mutationChain;
  }

  function projectMonitorBase(): void {
    setOwnerSymbols(
      { reason: 'MONITOR_BASE', ownerKey: 'all-monitors' },
      deps.tradingConfig.monitors.map((monitorConfig) => monitorConfig.monitorSymbol),
    );
  }

  function projectAllSeatBound(): void {
    const seatSymbols: string[] = [];
    for (const monitorConfig of deps.tradingConfig.monitors) {
      for (const direction of ['LONG', 'SHORT'] as const) {
        const seatState = deps.symbolRegistry.getSeatState(monitorConfig.monitorSymbol, direction);
        if (
          seatState.symbol &&
          (seatState.status === 'SWITCHING' ||
            seatState.status === 'ACTIVATING' ||
            seatState.status === 'ACTIVE')
        ) {
          seatSymbols.push(seatState.symbol);
        }
      }
    }

    setOwnerSymbols({ reason: 'SEAT_BOUND', ownerKey: 'all-seats' }, seatSymbols);
  }

  function projectOrderHold(): void {
    setOwnerSymbols(
      { reason: 'ORDER_HOLD', ownerKey: 'trader' },
      deps.trader.getOrderHoldSymbols(),
    );
  }

  function projectPositionHold(): void {
    setOwnerSymbols(
      { reason: 'POSITION_HOLD', ownerKey: 'last-state' },
      collectPositionSymbols(deps.lastState.cachedPositions),
    );
  }

  function handleSeatChanged(event: SeatStateChangedEvent): void {
    const symbols = collectSeatSymbols(event);
    projectAllSeatBound();
    void enqueueMutation().catch((error: unknown) => {
      logger.error(
        `[QuoteSubscriptionRuntime] 处理席位订阅变化失败 symbols=${symbols.join(',')}`,
        formatError(error),
      );
      deps.onFatalError?.(error);
    });
  }

  function handleOrderHoldChanged(_event: OrderHoldSymbolsChangedEvent): void {
    projectOrderHold();
    void enqueueMutation().catch((error: unknown) => {
      logger.error('[QuoteSubscriptionRuntime] 处理订单保留订阅变化失败', formatError(error));
      deps.onFatalError?.(error);
    });
  }

  async function reconcileFromCurrentTruth(): Promise<void> {
    projectMonitorBase();
    projectAllSeatBound();
    projectPositionHold();
    projectOrderHold();
    await enqueueMutation();
  }

  async function reconcilePositionHoldFromCurrentTruth(): Promise<void> {
    projectPositionHold();
    await enqueueMutation();
  }

  function start(): void {
    if (running) {
      return;
    }

    running = true;
    unsubscribeSeatStateChanged = deps.symbolRegistry.onSeatStateChanged(handleSeatChanged);
    unsubscribeOrderHoldChanged = deps.trader.onOrderHoldSymbolsChanged(handleOrderHoldChanged);
  }

  async function stopAndDrain(): Promise<void> {
    running = false;
    unsubscribeSeatStateChanged?.();
    unsubscribeSeatStateChanged = null;
    unsubscribeOrderHoldChanged?.();
    unsubscribeOrderHoldChanged = null;
    await mutationChain;
    retainsByOwner.clear();
    await enqueueMutation();
  }

  async function retainSymbols(params: QuoteSubscriptionRetainParams): Promise<Unsubscribe> {
    const owner: QuoteSubscriptionRetainOwner = {
      reason: params.reason,
      ownerKey: params.ownerKey,
    };
    setOwnerSymbols(owner, params.symbols);
    await enqueueMutation();
    return () => {
      void releaseRetain(owner).catch((error: unknown) => {
        logger.error('[QuoteSubscriptionRuntime] 释放 retain 失败', formatError(error));
        deps.onFatalError?.(error);
      });
    };
  }

  async function releaseRetain(
    params: Pick<QuoteSubscriptionRetainParams, 'ownerKey' | 'reason'>,
  ): Promise<void> {
    removeOwner(params);
    await enqueueMutation();
  }

  async function waitForAdmission(symbols: ReadonlyArray<string>): Promise<void> {
    await mutationChain;
    const committedSymbols = readCommittedSymbolsFromLastState();
    const missing = normalizeSymbols(symbols).filter(
      (symbol) => !committedSymbols.has(symbol) && hasRetainForSymbol(retainsByOwner, symbol),
    );
    if (missing.length > 0) {
      await enqueueMutation();
    }
  }

  return {
    reconcileFromCurrentTruth,
    reconcilePositionHoldFromCurrentTruth,
    start,
    stopAndDrain,
    retainSymbols,
    releaseRetain,
    waitForAdmission,
  };
}

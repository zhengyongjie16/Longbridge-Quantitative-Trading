/**
 * SeatActivationDispatcher
 *
 * 职责：
 * - 在 runtime 阶段监听 seat 进入 ACTIVATING
 * - 立即调度 SEAT_REFRESH，保留现有激活屏障语义
 * - 仅缓存 SWITCHING -> ACTIVATING 之间所需的旧标的，不持有 seat 真相
 */
import { logger } from '../../utils/logger/index.js';
import type { SeatState, SeatStateChangedEvent } from '../../types/seat.js';
import type {
  PendingSeatActivation,
  SeatActivationDispatcher,
  SeatActivationDispatcherDeps,
  SeatActivationRouteKey,
} from './types.js';

function buildSeatActivationRouteKey(params: {
  readonly monitorSymbol: string;
  readonly direction: 'LONG' | 'SHORT';
}): SeatActivationRouteKey {
  return `${params.monitorSymbol}:${params.direction}`;
}

function resolveNextSymbol(seatState: SeatState): string | null {
  if (seatState.status !== 'ACTIVATING' || !seatState.symbol) {
    return null;
  }

  return seatState.symbol;
}

function scheduleSeatRefresh(params: {
  readonly deps: SeatActivationDispatcherDeps;
  readonly monitorSymbol: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly seatVersion: number;
  readonly previousSymbol: string | null;
  readonly nextState: SeatState;
}): void {
  const nextSymbol = resolveNextSymbol(params.nextState);
  if (nextSymbol === null) {
    return;
  }

  const dedupeKey = `${params.monitorSymbol}:SEAT_REFRESH:${params.direction}`;
  params.deps.monitorTaskQueue.scheduleLatest({
    type: 'SEAT_REFRESH',
    dedupeKey,
    monitorSymbol: params.monitorSymbol,
    data: {
      monitorSymbol: params.monitorSymbol,
      direction: params.direction,
      seatVersion: params.seatVersion,
      previousSymbol: params.previousSymbol,
      nextSymbol,
      callPrice: params.nextState.callPrice ?? null,
      symbolName: null,
    },
  });

  logger.debug(
    `[SEAT_REFRESH scheduled] monitorSymbol=${params.monitorSymbol} direction=${params.direction} seatVersion=${params.seatVersion} previousSymbol=${params.previousSymbol ?? 'null'} nextSymbol=${nextSymbol} dedupeKey=${dedupeKey}`,
  );
}

/**
 * 创建席位激活调度器。
 *
 * @param deps 调度依赖
 * @returns SeatActivationDispatcher 实例
 */
export function createSeatActivationDispatcher(
  deps: SeatActivationDispatcherDeps,
): SeatActivationDispatcher {
  let running = false;
  let unsubscribeSeatStateChanged: (() => void) | null = null;
  const pendingActivations = new Map<SeatActivationRouteKey, PendingSeatActivation>();

  function clearPendingActivation(monitorSymbol: string, direction: 'LONG' | 'SHORT'): void {
    pendingActivations.delete(buildSeatActivationRouteKey({ monitorSymbol, direction }));
  }

  function rememberPendingActivation(event: SeatStateChangedEvent): void {
    const routeKey = buildSeatActivationRouteKey({
      monitorSymbol: event.monitorSymbol,
      direction: event.direction,
    });

    pendingActivations.set(routeKey, {
      seatVersion: event.nextVersion,
      oldSymbol: event.previousState.symbol ?? null,
    });
  }

  function resolvePreviousSymbol(event: SeatStateChangedEvent): string | null {
    const routeKey = buildSeatActivationRouteKey({
      monitorSymbol: event.monitorSymbol,
      direction: event.direction,
    });
    const pendingActivation = pendingActivations.get(routeKey);
    if (pendingActivation?.seatVersion === event.nextVersion) {
      return pendingActivation.oldSymbol;
    }

    return event.previousState.symbol ?? null;
  }

  function handleSeatStateChanged(event: SeatStateChangedEvent): void {
    if (event.nextState.status === 'SWITCHING') {
      rememberPendingActivation(event);
      return;
    }

    if (event.nextState.status !== 'ACTIVATING') {
      clearPendingActivation(event.monitorSymbol, event.direction);
      return;
    }

    const previousSymbol = resolvePreviousSymbol(event);
    clearPendingActivation(event.monitorSymbol, event.direction);

    scheduleSeatRefresh({
      deps,
      monitorSymbol: event.monitorSymbol,
      direction: event.direction,
      seatVersion: event.nextVersion,
      previousSymbol,
      nextState: event.nextState,
    });
  }

  function seedActivatingSeats(): void {
    for (const monitorConfig of deps.tradingConfig.monitors) {
      for (const direction of ['LONG', 'SHORT'] as const) {
        const seatState = deps.symbolRegistry.getSeatState(monitorConfig.monitorSymbol, direction);
        const seatVersion = deps.symbolRegistry.getSeatVersion(
          monitorConfig.monitorSymbol,
          direction,
        );
        if (seatState.status === 'ACTIVATING') {
          scheduleSeatRefresh({
            deps,
            monitorSymbol: monitorConfig.monitorSymbol,
            direction,
            seatVersion,
            previousSymbol: null,
            nextState: seatState,
          });
        }
      }
    }
  }

  function start(): void {
    if (running) {
      return;
    }

    running = true;
    pendingActivations.clear();
    unsubscribeSeatStateChanged = deps.symbolRegistry.onSeatStateChanged(handleSeatStateChanged);
    seedActivatingSeats();
  }

  function stop(): void {
    running = false;
    unsubscribeSeatStateChanged?.();
    unsubscribeSeatStateChanged = null;
    pendingActivations.clear();
  }

  return {
    start,
    stop,
  };
}

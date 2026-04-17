/**
 * orderMonitor routing index 模块
 *
 * 职责：
 * - 维护 symbol -> tracked orderIds 的索引
 * - 管理 route state 的创建、复用与销毁
 * - 在 route 移除或整体重置时，仅清理 route state 自己持有的 timer 句柄
 */
import type { OrderMonitorRuntimeStore, OrderMonitorSymbolRouteState } from './types.js';

/**
 * 创建单 symbol route 初始状态。
 *
 * @param symbol 交易标的
 * @param generation 当前 route generation
 * @returns 与 routeRuntime 既有测试构造一致的初始 route state
 */
function createInitialRouteState(symbol: string, generation: number): OrderMonitorSymbolRouteState {
  return {
    symbol,
    generation,
    inFlight: false,
    dirty: false,
    latestQuote: null,
    pendingWakeupKind: null,
    timerHandles: new Map(),
  };
}

/**
 * 解析 symbol 下一次可用的 route generation。
 *
 * generation 是同一 symbol route 的唯一执行代号，进程生命周期内只允许单调递增，
 * 这样旧 timer / 旧异步 continuation 才不会命中新建 route。
 *
 * @param runtime 订单监控运行态
 * @param symbol 交易标的
 * @returns 下一次创建 route 应使用的 generation
 */
function resolveNextRouteGeneration(runtime: OrderMonitorRuntimeStore, symbol: string): number {
  const latestGeneration = runtime.latestRouteGenerationBySymbol.get(symbol) ?? 0;
  const nextGeneration = latestGeneration + 1;
  runtime.latestRouteGenerationBySymbol.set(symbol, nextGeneration);
  return nextGeneration;
}

/**
 * 清理 route state 自己持有的 timer 句柄。
 *
 * @param routeState 单 symbol route state
 * @returns 无返回值
 */
function clearRouteTimers(routeState: OrderMonitorSymbolRouteState): void {
  for (const timerRegistration of routeState.timerHandles.values()) {
    clearTimeout(timerRegistration.handle);
  }

  routeState.timerHandles.clear();
}

/**
 * 确保 symbol 对应 route state 存在。
 *
 * @param runtime 订单监控运行态
 * @param symbol 交易标的
 * @returns 已存在或新建的 route state
 */
function ensureRouteState(
  runtime: OrderMonitorRuntimeStore,
  symbol: string,
): OrderMonitorSymbolRouteState {
  const existing = runtime.routeStatesBySymbol.get(symbol);
  if (existing) {
    return existing;
  }

  const created = createInitialRouteState(symbol, resolveNextRouteGeneration(runtime, symbol));
  runtime.routeStatesBySymbol.set(symbol, created);
  return created;
}

/**
 * 将 tracked order 挂到 symbol bucket，并确保 route state 存在。
 *
 * @param runtime 订单监控运行态
 * @param symbol 交易标的
 * @param orderId 订单 ID
 * @returns 无返回值
 */
export function attachTrackedOrder(
  runtime: OrderMonitorRuntimeStore,
  symbol: string,
  orderId: string,
): void {
  const bucket = runtime.trackedOrderIdsBySymbol.get(symbol) ?? new Set<string>();
  bucket.add(orderId);
  runtime.trackedOrderIdsBySymbol.set(symbol, bucket);
  ensureRouteState(runtime, symbol);
}

/**
 * 从 symbol bucket 移除 tracked order；若 bucket 为空则销毁 route state。
 *
 * @param runtime 订单监控运行态
 * @param symbol 交易标的
 * @param orderId 订单 ID
 * @returns 无返回值
 */
export function detachTrackedOrder(
  runtime: OrderMonitorRuntimeStore,
  symbol: string,
  orderId: string,
): void {
  const bucket = runtime.trackedOrderIdsBySymbol.get(symbol);
  if (!bucket) {
    return;
  }

  bucket.delete(orderId);
  if (bucket.size > 0) {
    return;
  }

  runtime.trackedOrderIdsBySymbol.delete(symbol);
  const routeState = runtime.routeStatesBySymbol.get(symbol);
  if (!routeState) {
    return;
  }

  clearRouteTimers(routeState);
  runtime.routeStatesBySymbol.delete(symbol);
}

/**
 * 重置全部 routing index 与 route states。
 *
 * @param runtime 订单监控运行态
 * @returns 无返回值
 */
export function resetRoutingIndex(runtime: OrderMonitorRuntimeStore): void {
  for (const routeState of runtime.routeStatesBySymbol.values()) {
    clearRouteTimers(routeState);
  }

  runtime.routeStatesBySymbol.clear();
  runtime.trackedOrderIdsBySymbol.clear();
}

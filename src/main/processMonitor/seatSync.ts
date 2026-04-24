/**
 * 席位同步与队列清理模块
 *
 * 功能：
 * - 同步席位状态到监控上下文（席位状态、版本、标的代码）
 * - 在时间循环入口补充展示所需的标的名称
 * - 当席位状态从 ACTIVE 变为非 ACTIVE 时，清理相关队列和延迟验证信号
 *
 * 清理触发条件：
 * - 席位状态从 ACTIVE 变为其他状态（EMPTY、SEARCHING、SWITCHING、ACTIVATING）
 * - 清理内容包括：延迟验证信号、待执行买入/卖出任务、监控任务、牛熊证信息
 *
 * 激活触发条件：
 * - 席位进入 ACTIVATING 后由 SeatActivationDispatcher 基于 seat event 直接调度 SEAT_REFRESH
 */
import { logger } from '../../utils/logger/index.js';
import {
  resolveMonitorContextRuntimeSnapshot,
  resolveMonitorContextSeatSnapshot,
} from '../../utils/utils.js';
import { clearMonitorDirectionQueues, logDirectionQueueCleanup } from './utils.js';
import type {
  SeatSyncParams,
  SeatSyncResult,
  SignalSeatInfo,
  SignalSeatSyncParams,
} from './types.js';

/**
 * 清理指定方向的延迟验证与各类任务队列，并同步清空牛熊证距离缓存。
 * 这样可确保席位从 ACTIVE 退化后不会继续执行过期信号，避免状态漂移。
 *
 * @param params 清理所需的监控上下文、方向与队列
 * @returns 无返回值
 */
function clearSignalDirectionRuntime(params: {
  readonly monitorSymbol: string;
  readonly monitorContext: SignalSeatSyncParams['monitorContext'];
  readonly direction: 'LONG' | 'SHORT';
  readonly mainContext: SignalSeatSyncParams['mainContext'];
}): void {
  const { monitorSymbol, monitorContext, direction, mainContext } = params;
  const { riskChecker, delayedSignalVerifier } = monitorContext;
  const { buyTaskQueue, sellTaskQueue, monitorTaskQueue } = mainContext;

  if (direction === 'LONG') {
    riskChecker.clearLongWarrantInfo();
  } else {
    riskChecker.clearShortWarrantInfo();
  }

  const result = clearMonitorDirectionQueues({
    monitorSymbol,
    direction,
    delayedSignalVerifier,
    buyTaskQueue,
    sellTaskQueue,
    monitorTaskQueue,
  });
  logDirectionQueueCleanup({
    source: '席位同步',
    monitorSymbol,
    direction,
    result,
    logger,
  });
}

/**
 * 同步普通信号链路所需的席位身份。
 * 只读取 symbolRegistry，不读取行情；monitor indicator 显示由 businessEventProgram 直接提交，trading quote 显示由 quote 事件 owner 推进。
 *
 * @param params 同步所需的监控上下文与队列依赖
 * @returns 普通信号入队所需的席位信息
 */
export function syncSignalSeatState(params: SignalSeatSyncParams): SignalSeatInfo {
  const { monitorSymbol, monitorContext, mainContext } = params;
  const previousLongSeatState = monitorContext.seatState.long;
  const previousShortSeatState = monitorContext.seatState.short;
  const seatSnapshot = resolveMonitorContextSeatSnapshot(
    monitorSymbol,
    monitorContext.symbolRegistry,
  );
  const longSeatState = seatSnapshot.seatState.long;
  const shortSeatState = seatSnapshot.seatState.short;

  monitorContext.seatState = seatSnapshot.seatState;
  monitorContext.seatVersion = seatSnapshot.seatVersion;

  if (previousLongSeatState.status === 'ACTIVE' && longSeatState.status !== 'ACTIVE') {
    clearSignalDirectionRuntime({
      monitorSymbol,
      monitorContext,
      direction: 'LONG',
      mainContext,
    });
  }

  if (previousShortSeatState.status === 'ACTIVE' && shortSeatState.status !== 'ACTIVE') {
    clearSignalDirectionRuntime({
      monitorSymbol,
      monitorContext,
      direction: 'SHORT',
      mainContext,
    });
  }

  return {
    longSeatState,
    shortSeatState,
    longSeatVersion: seatSnapshot.seatVersion.long,
    shortSeatVersion: seatSnapshot.seatVersion.short,
    longSeatActive: seatSnapshot.longSymbol !== null,
    shortSeatActive: seatSnapshot.shortSymbol !== null,
    longSymbol: seatSnapshot.longSymbol ?? '',
    shortSymbol: seatSnapshot.shortSymbol ?? '',
  };
}

/**
 * 同步席位状态到监控上下文。
 * 从 symbolRegistry 读取最新席位状态并写入 monitorContext；
 * 当席位从 ACTIVE 变为非 ACTIVE 时清理对应方向的队列和牛熊证信息；
 * 随后使用时间循环已读取的 quotesMap 补充展示名称。
 */
export function syncSeatState(params: SeatSyncParams): SeatSyncResult {
  const { monitorSymbol, monitorContext, mainContext, quotesMap } = params;
  const { symbolRegistry } = monitorContext;
  const seatInfo = syncSignalSeatState({
    monitorSymbol,
    monitorContext,
    mainContext,
  });
  const runtimeSnapshot = resolveMonitorContextRuntimeSnapshot(
    monitorSymbol,
    symbolRegistry,
    quotesMap,
  );

  monitorContext.longSymbolName = runtimeSnapshot.longSymbolName;
  monitorContext.shortSymbolName = runtimeSnapshot.shortSymbolName;
  monitorContext.monitorSymbolName = runtimeSnapshot.monitorSymbolName;

  return seatInfo;
}

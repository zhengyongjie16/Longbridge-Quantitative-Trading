/**
 * 席位投影模块
 *
 * 职责：
 * - 从 SymbolRegistry 读取普通信号链路所需的席位身份
 * - 将当前席位快照投影到 monitorContext 缓存
 * - 不清理任务队列、不刷新名称、不承担时间循环同步职责
 */
import { resolveMonitorContextSeatSnapshot } from '../../utils/seat/snapshots.js';
import type { SignalSeatInfo, SignalSeatProjectionParams } from './types.js';

/**
 * 解析普通信号链路所需的席位信息。
 * 该函数只读取 SymbolRegistry 并更新 monitorContext 的席位缓存，不产生清理副作用。
 *
 * @param params 监控标的与监控上下文
 * @returns 普通信号入队所需的席位信息
 */
export function resolveSignalSeatInfo(params: SignalSeatProjectionParams): SignalSeatInfo {
  const { monitorSymbol, monitorContext } = params;
  const seatSnapshot = resolveMonitorContextSeatSnapshot(
    monitorSymbol,
    monitorContext.symbolRegistry,
  );

  monitorContext.seatState = seatSnapshot.seatState;
  monitorContext.seatVersion = seatSnapshot.seatVersion;

  return {
    longSeatState: seatSnapshot.seatState.long,
    shortSeatState: seatSnapshot.seatState.short,
    longSeatVersion: seatSnapshot.seatVersion.long,
    shortSeatVersion: seatSnapshot.seatVersion.short,
    longSymbol: seatSnapshot.longSymbol ?? '',
    shortSymbol: seatSnapshot.shortSymbol ?? '',
  };
}

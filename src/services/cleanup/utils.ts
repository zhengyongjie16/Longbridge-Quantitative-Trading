import { releaseSnapshotObjects } from '../../utils/helpers/index.js';
import type { MonitorState } from '../../types/state.js';

/**
 * 释放所有监控标的的最后一个快照对象，用于跨日或程序退出时的内存回收。
 * @param monitorStates 监控状态 Map，键为监控标的代码
 * @returns void
 */
export function releaseAllMonitorSnapshots(
  monitorStates: ReadonlyMap<string, MonitorState>,
): void {
  for (const monitorState of monitorStates.values()) {
    releaseSnapshotObjects(monitorState.lastMonitorSnapshot, monitorState.monitorValues);
    monitorState.lastMonitorSnapshot = null;
  }
}

/**
 * 清理模块独享的工具函数
 */

import { releaseSnapshotObjects } from '../../utils/helpers/utils.js';
import type { MonitorState } from '../../types/index.js';

/**
 * 释放所有监控标的的最后一个快照对象
 * @param monitorStates 监控状态Map
 */
export function releaseAllMonitorSnapshots(monitorStates: Map<string, MonitorState>): void {
  for (const monitorState of monitorStates.values()) {
    releaseSnapshotObjects(monitorState.lastMonitorSnapshot, monitorState.monitorValues);
    monitorState.lastMonitorSnapshot = null;
  }
}

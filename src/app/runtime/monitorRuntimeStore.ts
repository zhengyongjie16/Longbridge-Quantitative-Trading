/**
 * 监控运行态 Store
 *
 * 职责：
 * - 统一持有 monitorStates 与 monitor runtime entries
 * - 让 MonitorContext 退化为 runtime entry 的 legacy facade
 */
import type { MonitorState } from '../../types/state.js';
import type { MonitorRuntimeState, MonitorRuntimeStore } from './types.js';

/**
 * 创建监控运行态 store。
 *
 * @param initialMonitorStates 各 monitor 的初始 MonitorState
 * @returns monitor runtime store
 */
export function createMonitorRuntimeStore(
  initialMonitorStates: ReadonlyMap<string, MonitorState>,
): MonitorRuntimeStore {
  const state: MonitorRuntimeState = {
    monitorStates: new Map(initialMonitorStates),
    entries: new Map(),
  };

  return {
    getState: () => state,
    ensureEntry: (entry) => {
      const existing = state.entries.get(entry.monitorSymbol);
      if (existing) {
        return existing;
      }

      state.monitorStates.set(entry.monitorSymbol, entry.state);
      state.entries.set(entry.monitorSymbol, entry);
      return entry;
    },
    getEntry: (monitorSymbol) => state.entries.get(monitorSymbol) ?? null,
  };
}

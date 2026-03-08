/**
 * 系统运行态 Store
 *
 * 职责：
 * - 作为 execution/lifecycle/account/position runtime 的唯一真相源
 * - 为 legacy LastState facade 提供稳定读写入口
 * - 为后续 GatePolicyResolver 收口预留 gate snapshot 位点
 */
import type { SystemRuntimeState, SystemRuntimeStateStore } from './types.js';

/**
 * 创建系统运行态 store。
 *
 * @param initialState 初始系统运行态
 * @returns 只暴露显式 setter 的系统运行态 store
 */
export function createSystemRuntimeStateStore(
  initialState: SystemRuntimeState,
): SystemRuntimeStateStore {
  const state: SystemRuntimeState = {
    ...initialState,
  };

  return {
    getState: () => state,
    setCanTrade: (canTrade) => {
      state.canTrade = canTrade;
    },
    setIsHalfDay: (isHalfDay) => {
      state.isHalfDay = isHalfDay;
    },
    setOpenProtectionActive: (openProtectionActive) => {
      state.openProtectionActive = openProtectionActive;
    },
    setCurrentDayKey: (currentDayKey) => {
      state.currentDayKey = currentDayKey;
    },
    setLifecycleState: (lifecycleState) => {
      state.lifecycleState = lifecycleState;
    },
    setPendingOpenRebuild: (pendingOpenRebuild) => {
      state.pendingOpenRebuild = pendingOpenRebuild;
    },
    setTargetTradingDayKey: (targetTradingDayKey) => {
      state.targetTradingDayKey = targetTradingDayKey;
    },
    setIsTradingEnabled: (isTradingEnabled) => {
      state.isTradingEnabled = isTradingEnabled;
    },
    setCachedAccount: (cachedAccount) => {
      state.cachedAccount = cachedAccount;
    },
    setCachedPositions: (cachedPositions) => {
      state.cachedPositions = cachedPositions;
    },
    setGatePolicySnapshot: (gatePolicySnapshot) => {
      state.gatePolicySnapshot = gatePolicySnapshot;
    },
  };
}

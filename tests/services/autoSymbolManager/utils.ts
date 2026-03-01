/**
 * autoSymbolManager 业务测试共用工具
 *
 * 供 autoSearch、switchStateMachine 等测试使用。
 */
import type { AutoSearchConfig } from '../../../src/types/config.js';

/**
 * 创建无操作 logger 替身，用于隔离日志副作用的测试。
 *
 * @returns 含 debug、info、warn、error 空实现的 logger 对象
 */
export function createLoggerStub(): {
  debug: () => void;
  info: () => void;
  warn: () => void;
  error: () => void;
} {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

/**
 * 返回默认自动寻标配置，便于测试中覆盖单字段。
 *
 * @returns 符合 AutoSearchConfig 的默认配置对象
 */
export function getDefaultAutoSearchConfig(): AutoSearchConfig {
  return {
    autoSearchEnabled: true,
    autoSearchMinDistancePctBull: 0.35,
    autoSearchMinDistancePctBear: -0.35,
    autoSearchMinTurnoverPerMinuteBull: 100_000,
    autoSearchMinTurnoverPerMinuteBear: 100_000,
    autoSearchExpiryMinMonths: 3,
    autoSearchOpenDelayMinutes: 0,
    switchIntervalMinutes: 0,
    switchDistanceRangeBull: { min: 0.2, max: 1.5 },
    switchDistanceRangeBear: { min: -1.5, max: -0.2 },
  };
}

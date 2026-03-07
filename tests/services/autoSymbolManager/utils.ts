/**
 * autoSymbolManager 业务测试共用工具
 *
 * 供 autoSearch、switchStateMachine 等测试使用。
 */
import type { AutoSearchConfig } from '../../../src/types/config.js';
import type {
  DirectionalAutoSearchPolicy,
  FindBestWarrantInput,
  WarrantCandidate,
} from '../../../src/services/autoSymbolFinder/types.js';
import type { Logger } from '../../../src/utils/logger/types.js';
import { createQuoteContextDouble } from '../../helpers/testDoubles.js';

/**
 * 创建无操作 logger 替身，用于隔离日志副作用的测试。
 *
 * @returns 含 debug、info、warn、error 空实现的 logger 对象
 */
export function createLoggerStub(): {
  readonly debug: Logger['debug'];
  readonly info: Logger['info'];
  readonly warn: Logger['warn'];
  readonly error: Logger['error'];
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

/**
 * 构造方向化自动寻标策略，供 autoSymbolManager 相关测试复用。
 *
 * @param direction 方向（LONG/SHORT）
 * @returns 与默认自动寻标配置对齐的共享策略对象
 */
export function createDirectionalAutoSearchPolicy(
  direction: 'LONG' | 'SHORT',
): DirectionalAutoSearchPolicy {
  if (direction === 'LONG') {
    return {
      direction,
      primaryThreshold: 0.35,
      minTurnoverPerMinute: 100_000,
      degradedRange: { min: 0.2, max: 0.35 },
      switchDistanceRange: { min: 0.2, max: 1.5 },
    };
  }

  return {
    direction,
    primaryThreshold: -0.35,
    minTurnoverPerMinute: 100_000,
    degradedRange: { min: -0.35, max: -0.2 },
    switchDistanceRange: { min: -1.5, max: -0.2 },
  };
}

/**
 * 构造自动寻标候选结果，避免测试中重复填写命中阶段字段。
 *
 * @param symbol 标的代码
 * @returns 默认命中主条件的候选
 */
export function createWarrantCandidate(symbol: string): WarrantCandidate {
  return createWarrantCandidateWithOverrides(symbol);
}

/**
 * 构造自动寻标候选结果，并允许覆盖默认字段。
 *
 * @param symbol 标的代码
 * @param overrides 需要覆盖的候选字段
 * @returns 默认命中主条件的候选
 */
export function createWarrantCandidateWithOverrides(
  symbol: string,
  overrides: Partial<WarrantCandidate> = {},
): WarrantCandidate {
  return {
    symbol,
    name: symbol,
    callPrice: 21_000,
    distancePct: 0.5,
    turnover: 1_000_000,
    turnoverPerMinute: 100_000,
    selectionStage: 'PRIMARY',
    distanceDeltaToThreshold: 0.15,
    ...overrides,
  };
}

/**
 * 构造最小可用的 FindBestWarrantInput，供 autoSymbolManager 相关测试复用。
 *
 * @param policy 寻标策略；默认使用 LONG 方向策略
 * @returns 类型完整的 finder 入参
 */
export function createFindBestWarrantInputDouble(
  policy: DirectionalAutoSearchPolicy = createDirectionalAutoSearchPolicy('LONG'),
): FindBestWarrantInput {
  return {
    ctx: createQuoteContextDouble(),
    monitorSymbol: 'HSI.HK',
    tradingMinutes: 10,
    policy,
    expiryMinMonths: 3,
    logger: createLoggerStub(),
  };
}

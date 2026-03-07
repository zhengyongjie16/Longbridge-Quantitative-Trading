/**
 * 自动寻标策略构造模块
 *
 * 功能：将监控配置解析为方向化自动寻标策略对象，并基于共享策略统一构造 findBestWarrant 输入。
 * 职责：在策略构造边界校验主阈值、降级区间与换标区间不变量，避免启动/运行时/换标预寻标重复拼装。
 * 执行流程：resolveDirectionalAutoSearchPolicy 校验配置 → 构造策略对象 → buildFindBestWarrantInputFromPolicy 组装 Finder 输入。
 */
import { formatDecimal } from '../../utils/numeric/index.js';
import type {
  BuildFindBestWarrantInputFromPolicyParams,
  DirectionalAutoSearchPolicy,
  FindBestWarrantInput,
  ResolveDirectionalAutoSearchPolicyInput,
} from './types.js';

/**
 * 判断方向是否为做多（牛证）方向。
 *
 * @param direction 寻标方向
 * @returns LONG 时返回 true，否则返回 false
 */
function isLongDirection(direction: DirectionalAutoSearchPolicy['direction']): boolean {
  return direction === 'LONG';
}

/**
 * 构造策略失败日志。
 *
 * @param params 日志所需上下文
 * @returns 统一格式的错误文案
 */
function buildPolicyErrorMessage(params: {
  readonly logPrefix: string;
  readonly monitorSymbol: string;
  readonly direction: DirectionalAutoSearchPolicy['direction'];
  readonly message: string;
}): string {
  return `${params.logPrefix}: ${params.monitorSymbol} ${params.direction} ${params.message}`;
}

/**
 * 从配置中提取某一方向的主阈值、成交额阈值与换标区间。
 *
 * @param input 策略构造入参
 * @returns 方向对应的阈值快照
 */
function resolveDirectionalThresholdSnapshot(input: ResolveDirectionalAutoSearchPolicyInput): {
  readonly primaryThreshold: number | null;
  readonly minTurnoverPerMinute: number | null;
  readonly switchDistanceRange: DirectionalAutoSearchPolicy['switchDistanceRange'] | null;
} {
  const isLong = isLongDirection(input.direction);
  return {
    primaryThreshold: isLong
      ? input.autoSearchConfig.autoSearchMinDistancePctBull
      : input.autoSearchConfig.autoSearchMinDistancePctBear,
    minTurnoverPerMinute: isLong
      ? input.autoSearchConfig.autoSearchMinTurnoverPerMinuteBull
      : input.autoSearchConfig.autoSearchMinTurnoverPerMinuteBear,
    switchDistanceRange: isLong
      ? input.autoSearchConfig.switchDistanceRangeBull
      : input.autoSearchConfig.switchDistanceRangeBear,
  };
}

/**
 * 校验阈值快照是否都是有限数。
 *
 * @param snapshot 方向化阈值快照
 * @returns 合法时返回 null，否则返回错误原因
 */
function validateFiniteThresholdSnapshot(snapshot: {
  readonly primaryThreshold: number;
  readonly minTurnoverPerMinute: number;
  readonly switchDistanceRange: DirectionalAutoSearchPolicy['switchDistanceRange'];
}): string | null {
  if (!Number.isFinite(snapshot.primaryThreshold)) {
    return '主阈值不是有限数';
  }

  if (!Number.isFinite(snapshot.minTurnoverPerMinute)) {
    return '分均成交额阈值不是有限数';
  }

  if (snapshot.minTurnoverPerMinute < 0) {
    return '分均成交额阈值不能小于 0';
  }

  if (
    !Number.isFinite(snapshot.switchDistanceRange.min) ||
    !Number.isFinite(snapshot.switchDistanceRange.max)
  ) {
    return '换标区间边界不是有限数';
  }

  return null;
}

/**
 * 校验方向化策略的降级区间不变量。
 *
 * @param policy 待校验的方向化策略
 * @returns 合法时返回 null，否则返回错误原因
 */
function validatePolicyInvariants(policy: DirectionalAutoSearchPolicy): string | null {
  const isLong = isLongDirection(policy.direction);

  if (!Number.isFinite(policy.degradedRange.min) || !Number.isFinite(policy.degradedRange.max)) {
    return '降级区间边界不是有限数';
  }

  if (policy.degradedRange.min >= policy.degradedRange.max) {
    return `降级区间无效，要求 min < max，当前值为 ${formatDecimal(
      policy.degradedRange.min,
      4,
    )},${formatDecimal(policy.degradedRange.max, 4)}`;
  }

  // 校验降级区间与主阈值的关系
  const degradedRangeInvalid = isLong
    ? policy.degradedRange.min >= policy.primaryThreshold
    : policy.primaryThreshold >= policy.degradedRange.max;

  if (degradedRangeInvalid) {
    const constraint = isLong ? 'lowerBound < primaryThreshold' : 'primaryThreshold < upperBound';
    const actualValue = isLong
      ? `${formatDecimal(policy.degradedRange.min, 4)} >= ${formatDecimal(policy.primaryThreshold, 4)}`
      : `${formatDecimal(policy.primaryThreshold, 4)} >= ${formatDecimal(policy.degradedRange.max, 4)}`;
    return `降级区间无效，要求 ${constraint}，当前值为 ${actualValue}`;
  }

  // 校验换标区间
  if (policy.switchDistanceRange.min > policy.switchDistanceRange.max) {
    return `换标区间无效，要求 min <= max，当前值为 ${formatDecimal(
      policy.switchDistanceRange.min,
      4,
    )},${formatDecimal(policy.switchDistanceRange.max, 4)}`;
  }

  if (policy.switchDistanceRange.min >= policy.primaryThreshold) {
    return (
      '主阈值未严格落在换标安全区间内部，要求 ' +
      `switchDistanceRange.min < primaryThreshold，当前值为 ${formatDecimal(
        policy.switchDistanceRange.min,
        4,
      )} >= ${formatDecimal(policy.primaryThreshold, 4)}`
    );
  }

  if (policy.primaryThreshold >= policy.switchDistanceRange.max) {
    return (
      '主阈值未严格落在换标安全区间内部，要求 ' +
      `primaryThreshold < switchDistanceRange.max，当前值为 ${formatDecimal(
        policy.primaryThreshold,
        4,
      )} >= ${formatDecimal(policy.switchDistanceRange.max, 4)}`
    );
  }

  return null;
}

/**
 * 基于自动寻标配置构造方向化共享策略。
 * 构造失败时记录日志并返回 null，调用方不得自行猜测区间关系。
 *
 * @param input 策略构造入参
 * @returns 成功时返回共享策略，失败时返回 null
 */
export function resolveDirectionalAutoSearchPolicy(
  input: ResolveDirectionalAutoSearchPolicyInput,
): DirectionalAutoSearchPolicy | null {
  const thresholdSnapshot = resolveDirectionalThresholdSnapshot(input);
  if (
    thresholdSnapshot.primaryThreshold === null ||
    thresholdSnapshot.minTurnoverPerMinute === null ||
    thresholdSnapshot.switchDistanceRange === null
  ) {
    input.logger.error(
      buildPolicyErrorMessage({
        logPrefix: input.logPrefix,
        monitorSymbol: input.monitorSymbol,
        direction: input.direction,
        message: '缺少自动寻标阈值或换标区间配置',
      }),
    );
    return null;
  }

  const finiteSnapshotError = validateFiniteThresholdSnapshot({
    primaryThreshold: thresholdSnapshot.primaryThreshold,
    minTurnoverPerMinute: thresholdSnapshot.minTurnoverPerMinute,
    switchDistanceRange: thresholdSnapshot.switchDistanceRange,
  });
  if (finiteSnapshotError !== null) {
    input.logger.error(
      buildPolicyErrorMessage({
        logPrefix: input.logPrefix,
        monitorSymbol: input.monitorSymbol,
        direction: input.direction,
        message: finiteSnapshotError,
      }),
    );
    return null;
  }

  const degradedRange = isLongDirection(input.direction)
    ? {
        min: thresholdSnapshot.switchDistanceRange.min,
        max: thresholdSnapshot.primaryThreshold,
      }
    : {
        min: thresholdSnapshot.primaryThreshold,
        max: thresholdSnapshot.switchDistanceRange.max,
      };

  const policy: DirectionalAutoSearchPolicy = {
    direction: input.direction,
    primaryThreshold: thresholdSnapshot.primaryThreshold,
    minTurnoverPerMinute: thresholdSnapshot.minTurnoverPerMinute,
    degradedRange,
    switchDistanceRange: thresholdSnapshot.switchDistanceRange,
  };

  const invariantError = validatePolicyInvariants(policy);
  if (invariantError !== null) {
    input.logger.error(
      buildPolicyErrorMessage({
        logPrefix: input.logPrefix,
        monitorSymbol: input.monitorSymbol,
        direction: input.direction,
        message: invariantError,
      }),
    );
    return null;
  }

  return policy;
}

/**
 * 基于共享策略构造 findBestWarrant 入参。
 *
 * @param params 构造输入
 * @returns 统一的自动寻标 finder 入参
 */
export function buildFindBestWarrantInputFromPolicy(
  params: BuildFindBestWarrantInputFromPolicyParams,
): FindBestWarrantInput {
  return {
    ctx: params.ctx,
    monitorSymbol: params.monitorSymbol,
    tradingMinutes: params.getTradingMinutesSinceOpen(params.currentTime),
    policy: params.policy,
    expiryMinMonths: params.expiryMinMonths,
    logger: params.logger,
    ...(params.cacheConfig ? { cacheConfig: params.cacheConfig } : {}),
  };
}

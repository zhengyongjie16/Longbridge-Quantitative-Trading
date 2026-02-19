import type { RunMode, GateMode } from '../../types/seat.js';

/**
 * 从环境变量解析运行模式。未设置或非 'dev' 时默认为 'prod'。
 *
 * @param env 环境变量对象（如 process.env）
 * @returns 'dev' 或 'prod'，默认 'prod'
 */
export function resolveRunMode(env: NodeJS.ProcessEnv): RunMode {
  const raw = env['RUN_MODE'];
  const normalized = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return normalized === 'dev' ? 'dev' : 'prod';
}

/**
 * 根据运行模式解析门禁策略。dev 时启动与运行时均跳过门禁（skip），否则均为严格模式（strict）。
 *
 * @param runMode 运行模式（'dev' | 'prod'）
 * @returns 启动门禁与运行时门禁的配置（startupGate、runtimeGate）
 */
export function resolveGatePolicies(runMode: RunMode): {
  readonly startupGate: GateMode;
  readonly runtimeGate: GateMode;
} {
  if (runMode === 'dev') {
    return { startupGate: 'skip', runtimeGate: 'skip' };
  }
  return { startupGate: 'strict', runtimeGate: 'strict' };
}

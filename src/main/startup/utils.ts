/**
 * 启动流程工具函数模块
 *
 * 功能：
 * - resolveRunMode()：解析运行模式（dev/prod）
 * - resolveGatePolicies()：根据运行模式解析门禁策略
 *
 * 运行模式说明：
 * - prod（默认）：生产模式，启用所有门禁检查
 * - dev：开发模式，跳过门禁检查便于调试
 */
import type { RunMode, GateMode } from '../../types/index.js';

/**
 * 解析运行模式
 * @param env 环境变量对象
 * @returns 'dev' 或 'prod'，默认为 'prod'
 */
export function resolveRunMode(env: NodeJS.ProcessEnv): RunMode {
  const raw = env['RUN_MODE'];
  const normalized = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return normalized === 'dev' ? 'dev' : 'prod';
}

/**
 * 根据运行模式解析门禁策略
 * @param runMode 运行模式
 * @returns 启动门禁和运行时门禁的配置策略
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

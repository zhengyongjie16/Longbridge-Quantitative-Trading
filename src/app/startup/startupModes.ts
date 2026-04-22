/**
 * app 启动模式解析模块
 *
 * 职责：
 * - 从独立门禁配置解析 startup/runtime gate 策略
 */
import type { GatePolicies } from '../types.js';
import type { GateMode } from '../../types/seat.js';

/**
 * 解析单个门禁模式。仅显式 `skip` 才会跳过门禁，其余值均使用 `strict`。
 *
 * @param rawMode 单个门禁环境变量原始值
 * @returns 门禁模式（strict | skip）
 */
function resolveGateMode(rawMode: string | undefined): GateMode {
  if (typeof rawMode !== 'string') {
    return 'strict';
  }

  const normalized = rawMode.trim().toLowerCase();
  if (normalized === 'skip') {
    return 'skip';
  }

  return 'strict';
}

/**
 * 从环境变量解析 startup/runtime gate 策略。
 *
 * @param env 环境变量对象（如 process.env）
 * @returns 启动门禁与运行时门禁的配置（startupGate、runtimeGate）
 */
export function resolveGatePolicies(env: NodeJS.ProcessEnv): GatePolicies {
  return {
    startupGate: resolveGateMode(env['STARTUP_GATE_MODE']),
    runtimeGate: resolveGateMode(env['RUNTIME_GATE_MODE']),
  };
}

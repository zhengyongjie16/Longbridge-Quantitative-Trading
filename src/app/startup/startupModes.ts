/**
 * app 启动模式解析模块
 *
 * 职责：
 * - 从环境变量解析运行模式
 * - 从独立门禁配置解析 startup/runtime gate 策略与来源
 */
import type { GatePolicies, GatePolicySources } from '../types.js';
import type { GateMode, RunMode } from '../../types/seat.js';

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
 * 判断门禁配置是否来自显式环境变量。
 *
 * @param rawMode 单个门禁环境变量原始值
 * @returns true 表示来源为显式配置；false 表示使用默认配置
 */
function isExplicitGateMode(rawMode: string | undefined): boolean {
  if (typeof rawMode !== 'string') {
    return false;
  }

  return rawMode.trim().length > 0;
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

/**
 * 从环境变量解析 startup/runtime gate 策略来源。
 *
 * @param env 环境变量对象（如 process.env）
 * @returns startup/runtime gate 的来源标签（default | explicit）
 */
export function resolveGatePolicySources(env: NodeJS.ProcessEnv): GatePolicySources {
  return {
    startupGateSource: isExplicitGateMode(env['STARTUP_GATE_MODE']) ? 'explicit' : 'default',
    runtimeGateSource: isExplicitGateMode(env['RUNTIME_GATE_MODE']) ? 'explicit' : 'default',
  };
}

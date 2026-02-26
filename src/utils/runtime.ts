import path from 'node:path';
import { RUNTIME } from '../constants/index.js';
import type { RuntimeProfile } from '../types/runtime.js';

/**
 * 解析布尔环境变量字符串。
 * 默认行为：无法识别时返回 null。
 *
 * @param value 环境变量原始字符串
 * @returns true/false 或 null
 */
function parseBooleanEnv(value: string | undefined): boolean | null {
  if (value === undefined) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') {
    return true;
  }
  if (normalized === 'false' || normalized === '0') {
    return false;
  }
  return null;
}

/**
 * 解析运行时档位（正式/测试）。
 * 默认行为：显式配置优先，其次根据测试环境变量推断，最后回退为 app。
 *
 * @param env 环境变量对象
 * @returns 运行时档位（'app' | 'test'）
 */
export function resolveRuntimeProfile(env: NodeJS.ProcessEnv): RuntimeProfile {
  const explicitProfile = env[RUNTIME.PROFILE_ENV_KEY]?.trim().toLowerCase();
  if (explicitProfile === RUNTIME.TEST_PROFILE) {
    return RUNTIME.TEST_PROFILE;
  }
  if (explicitProfile === RUNTIME.APP_PROFILE) {
    return RUNTIME.APP_PROFILE;
  }

  if (env['BUN_TEST'] === '1') {
    return RUNTIME.TEST_PROFILE;
  }
  return RUNTIME.APP_PROFILE;
}

/**
 * 解析日志根目录绝对路径。
 * 默认行为：test 档位使用 `<cwd>/tests/logs`，app 档位使用 `<cwd>/logs`。
 *
 * @param env 环境变量对象
 * @returns 日志根目录绝对路径
 */
export function resolveLogRootDir(env: NodeJS.ProcessEnv): string {
  const configuredRootDir = env[RUNTIME.LOG_ROOT_DIR_ENV_KEY];
  if (typeof configuredRootDir === 'string' && configuredRootDir.trim() !== '') {
    return path.resolve(process.cwd(), configuredRootDir.trim());
  }

  if (resolveRuntimeProfile(env) === RUNTIME.TEST_PROFILE) {
    return path.join(process.cwd(), 'tests', 'logs');
  }
  return path.join(process.cwd(), 'logs');
}

/**
 * 判断当前运行时是否应注册进程级全局钩子。
 * 默认行为：test 档位禁用，app 档位启用；可通过环境变量显式覆盖。
 *
 * @param env 环境变量对象
 * @returns true 表示启用进程级钩子
 */
export function shouldInstallGlobalProcessHooks(env: NodeJS.ProcessEnv): boolean {
  const explicit = parseBooleanEnv(env[RUNTIME.ENABLE_PROCESS_HOOKS_ENV_KEY]);
  if (explicit !== null) {
    return explicit;
  }
  return resolveRuntimeProfile(env) === RUNTIME.APP_PROFILE;
}

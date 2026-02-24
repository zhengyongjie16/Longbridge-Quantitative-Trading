import path from 'node:path';

const APP_RUNTIME_PROFILE_ENV_KEY = 'APP_RUNTIME_PROFILE';
const APP_LOG_ROOT_DIR_ENV_KEY = 'APP_LOG_ROOT_DIR';
const APP_ENABLE_PROCESS_HOOKS_ENV_KEY = 'APP_ENABLE_PROCESS_HOOKS';

const DEFAULT_APP_PROFILE = 'app';
const TEST_PROFILE = 'test';
const APP_PROFILE = 'app';

export type RuntimeProfile = 'app' | 'test';

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
function resolveRuntimeProfile(env: NodeJS.ProcessEnv): RuntimeProfile {
  const explicitProfile = env[APP_RUNTIME_PROFILE_ENV_KEY]?.trim().toLowerCase();
  if (explicitProfile === TEST_PROFILE) {
    return 'test';
  }
  if (explicitProfile === APP_PROFILE) {
    return 'app';
  }

  if (env['BUN_TEST'] === '1') {
    return 'test';
  }
  return DEFAULT_APP_PROFILE;
}

/**
 * 解析日志根目录绝对路径。
 * 默认行为：test 档位使用 `<cwd>/tests/logs`，app 档位使用 `<cwd>/logs`。
 *
 * @param env 环境变量对象
 * @returns 日志根目录绝对路径
 */
export function resolveLogRootDir(env: NodeJS.ProcessEnv): string {
  const configuredRootDir = env[APP_LOG_ROOT_DIR_ENV_KEY];
  if (typeof configuredRootDir === 'string' && configuredRootDir.trim() !== '') {
    return path.resolve(process.cwd(), configuredRootDir.trim());
  }

  if (resolveRuntimeProfile(env) === 'test') {
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
  const explicit = parseBooleanEnv(env[APP_ENABLE_PROCESS_HOOKS_ENV_KEY]);
  if (explicit !== null) {
    return explicit;
  }
  return resolveRuntimeProfile(env) === 'app';
}

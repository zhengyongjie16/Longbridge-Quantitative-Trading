/**
 * runtime 工具模块业务测试
 *
 * 功能：
 * - 验证运行时档位解析、日志根目录解析与进程钩子开关解析。
 */
import { describe, expect, it } from 'bun:test';
import path from 'node:path';

import {
  resolveRuntimeProfile,
  resolveLogRootDir,
  shouldInstallGlobalProcessHooks,
} from '../../src/utils/runtime/index.js';

describe('runtime utils business flow', () => {
  it('loads test runtime preload defaults for the whole test process', () => {
    expect(process.env['APP_RUNTIME_PROFILE']).toBe('test');
    expect(process.env['APP_ENABLE_PROCESS_HOOKS']).toBe('false');
    expect(process.env['APP_LOG_ROOT_DIR']).toBe(path.join(process.cwd(), 'tests', 'logs'));
  });

  it('resolves runtime profile by explicit config and bun test env fallback', () => {
    const explicitTest = resolveRuntimeProfile({
      APP_RUNTIME_PROFILE: 'test',
    });
    expect(explicitTest).toBe('test');

    const explicitApp = resolveRuntimeProfile({
      APP_RUNTIME_PROFILE: 'app',
      BUN_TEST: '1',
    });
    expect(explicitApp).toBe('app');

    const bunTestFallback = resolveRuntimeProfile({
      BUN_TEST: '1',
    });
    expect(bunTestFallback).toBe('test');

    const nodeEnvOnly = resolveRuntimeProfile({
      NODE_ENV: 'test',
    });
    expect(nodeEnvOnly).toBe('app');

    const defaultApp = resolveRuntimeProfile({});
    expect(defaultApp).toBe('app');
  });

  it('resolves log root dir with explicit path and profile defaults', () => {
    const explicitPath = resolveLogRootDir({
      APP_LOG_ROOT_DIR: 'tests/logs/custom',
    });
    expect(explicitPath).toBe(path.resolve(process.cwd(), 'tests/logs/custom'));

    const testDefaultPath = resolveLogRootDir({
      APP_RUNTIME_PROFILE: 'test',
    });
    expect(testDefaultPath).toBe(path.join(process.cwd(), 'tests', 'logs'));

    const appDefaultPath = resolveLogRootDir({
      APP_RUNTIME_PROFILE: 'app',
    });
    expect(appDefaultPath).toBe(path.join(process.cwd(), 'logs'));
  });

  it('resolves global process hook switch by explicit override and profile defaults', () => {
    const explicitDisabled = shouldInstallGlobalProcessHooks({
      APP_ENABLE_PROCESS_HOOKS: 'false',
      APP_RUNTIME_PROFILE: 'app',
    });
    expect(explicitDisabled).toBe(false);

    const explicitEnabled = shouldInstallGlobalProcessHooks({
      APP_ENABLE_PROCESS_HOOKS: 'true',
      APP_RUNTIME_PROFILE: 'test',
    });
    expect(explicitEnabled).toBe(true);

    const testDefault = shouldInstallGlobalProcessHooks({
      APP_RUNTIME_PROFILE: 'test',
    });
    expect(testDefault).toBe(false);

    const appDefault = shouldInstallGlobalProcessHooks({
      APP_RUNTIME_PROFILE: 'app',
    });
    expect(appDefault).toBe(true);
  });
});

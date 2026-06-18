/**
 * src/index 入口业务测试
 *
 * 覆盖：
 * - 校验薄入口加载 dotenv 并把当前 env 传给 app 组装层
 * - 校验配置校验失败与未知异常的顶层退出语义
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const dotenvConfigCalls: unknown[] = [];
const runAppCalls: Array<{ readonly env: NodeJS.ProcessEnv }> = [];
const errorCalls: Array<ReadonlyArray<unknown>> = [];

class ExitSignal extends Error {
  public readonly code: number | undefined;

  public constructor(code: number | undefined) {
    super(`exit:${String(code)}`);
    this.name = 'ExitSignal';
    this.code = code;
  }
}

const originalConsoleError = console.error;
const originalProcessExit = process.exit;

function createNamedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function registerDotenvMock(): void {
  void mock.module('dotenv', () => ({
    default: {
      config: (options: unknown) => {
        dotenvConfigCalls.push(options);
      },
    },
  }));
}

function registerRunAppMock(
  implementation: (params: { readonly env: NodeJS.ProcessEnv }) => Promise<void>,
): void {
  void mock.module('../../src/app/runApp.js', () => ({
    runApp: async (params: { readonly env: NodeJS.ProcessEnv }) => {
      runAppCalls.push(params);
      await implementation(params);
    },
  }));
}

async function importEntryModule(label: string): Promise<void> {
  await import(`../../src/index.js?index-business-test-${label}-${Date.now()}`);
}

beforeEach(() => {
  dotenvConfigCalls.length = 0;
  runAppCalls.length = 0;
  errorCalls.length = 0;
  console.error = ((...args: ReadonlyArray<unknown>) => {
    errorCalls.push(args);
  }) as typeof console.error;

  process.exit = ((code?: number) => {
    throw new ExitSignal(code);
  });
});

afterEach(() => {
  console.error = originalConsoleError;
  process.exit = originalProcessExit;
  if (typeof mock.restore === 'function') {
    mock.restore();
  }
});

describe('src/index entry flow', () => {
  it('loads dotenv and forwards the current process env to runApp', async () => {
    registerDotenvMock();
    registerRunAppMock(async () => {});

    await importEntryModule('success');

    expect(dotenvConfigCalls).toEqual([{ path: '.env.local' }]);
    expect(runAppCalls).toHaveLength(1);
    expect(runAppCalls[0]?.env).toBe(process.env);
    expect(errorCalls).toHaveLength(0);
  });

  it('logs a focused startup message and exits when config validation fails', async () => {
    registerDotenvMock();
    registerRunAppMock(async () => {
      throw createNamedError('ConfigValidationError', 'missing env');
    });

    let caught: unknown = null;
    try {
      await importEntryModule('config-validation-error');
    } catch (error) {
      caught = error;
    }

    expect(dotenvConfigCalls).toEqual([{ path: '.env.local' }]);
    expect(runAppCalls).toHaveLength(1);
    expect(caught).toBeInstanceOf(ExitSignal);
    expect((caught as ExitSignal).code).toBe(1);
    expect(errorCalls).toEqual([['程序启动失败：配置验证未通过']]);
  });

  it('logs unknown startup failures with the original error and exits', async () => {
    const startupError = new Error('boom');

    registerDotenvMock();
    registerRunAppMock(async () => {
      throw startupError;
    });

    let caught: unknown = null;
    try {
      await importEntryModule('unknown-error');
    } catch (error) {
      caught = error;
    }

    expect(dotenvConfigCalls).toEqual([{ path: '.env.local' }]);
    expect(runAppCalls).toHaveLength(1);
    expect(caught).toBeInstanceOf(ExitSignal);
    expect((caught as ExitSignal).code).toBe(1);
    expect(errorCalls).toEqual([['程序异常退出', startupError]]);
  });
});

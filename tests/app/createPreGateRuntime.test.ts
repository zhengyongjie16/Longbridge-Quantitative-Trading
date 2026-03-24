/**
 * createPreGateRuntime 启动前阶段测试
 *
 * 功能：验证解析阶段的 fail-fast 配置错误会直接以 ConfigValidationError 契约抛出，避免绕过既有配置错误出口。
 */
import { describe, expect, it } from 'bun:test';

import { createPreGateRuntime } from '../../src/app/runtime/createPreGateRuntime.js';

function isConfigValidationError(error: unknown): error is {
  readonly name?: string;
  readonly message?: string;
  readonly missingFields?: ReadonlyArray<string>;
} {
  return typeof error === 'object' && error !== null;
}

describe('app createPreGateRuntime config error contract', () => {
  it('propagates parse-stage fail-fast config errors as ConfigValidationError', async () => {
    const env: NodeJS.ProcessEnv = {
      LONGBRIDGE_AUTH_MODE: 'oauth',
      LONGBRIDGE_CLIENT_ID: 'client-id',
      MONITOR_SYMBOL_1: 'HSI.HK',
      TARGET_NOTIONAL_1: '0',
    };

    let caughtError: unknown = null;
    try {
      await createPreGateRuntime({ env });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).not.toBeNull();
    expect(isConfigValidationError(caughtError)).toBe(true);
    if (!isConfigValidationError(caughtError)) {
      throw new Error('expected ConfigValidationError');
    }

    expect(caughtError.name).toBe('ConfigValidationError');
    expect(caughtError.message).toContain('TARGET_NOTIONAL_1');
    expect(caughtError.missingFields).toContain('TARGET_NOTIONAL_1');
  });
});

/**
 * Longbridge 认证配置业务测试
 *
 * 功能：
 * - 验证双认证模式下的启动配置校验行为
 */
import { describe, expect, it } from 'bun:test';
import { validateAllConfig } from '../../src/config/config.validator.js';
import { createMonitorConfigDouble } from '../helpers/testDoubles.js';
import { createTradingConfig } from '../../mock/factories/configFactory.js';

function createSignalConfig() {
  return {
    conditionGroups: [
      {
        conditions: [{ indicator: 'K', operator: '>', threshold: 1 }],
        requiredCount: 1,
      },
    ],
  } as const;
}

function createTradingConfigForValidation() {
  const signalConfig = createSignalConfig();
  return createTradingConfig({
    monitors: [
      createMonitorConfigDouble({
        orderOwnershipMapping: ['HSI'],
        signalConfig: {
          buycall: signalConfig,
          sellcall: signalConfig,
          buyput: signalConfig,
          sellput: signalConfig,
        },
      }),
    ],
  });
}

async function validateEnv(env: NodeJS.ProcessEnv): Promise<unknown> {
  try {
    await validateAllConfig({
      env,
      tradingConfig: createTradingConfigForValidation(),
    });
    return null;
  } catch (error) {
    return error;
  }
}

describe('longbridge auth config validation', () => {
  it('rejects missing auth mode before auth fields are evaluated', async () => {
    const error = await validateEnv({
      LONGBRIDGE_CLIENT_ID: 'client-id',
    });

    expect(error).not.toBeNull();
    const validationError = error as { missingFields?: ReadonlyArray<string> };
    expect(validationError.missingFields).toContain('LONGBRIDGE_AUTH_MODE');
  });

  it('rejects an invalid auth mode', async () => {
    const error = await validateEnv({
      LONGBRIDGE_AUTH_MODE: 'token',
      LONGBRIDGE_CLIENT_ID: 'client-id',
    });

    expect(error).not.toBeNull();
    const validationError = error as { missingFields?: ReadonlyArray<string> };
    expect(validationError.missingFields).toContain('LONGBRIDGE_AUTH_MODE');
  });

  it('rejects the .env.example placeholder client id as missing config', async () => {
    const error = await validateEnv({
      LONGBRIDGE_AUTH_MODE: 'oauth',
      LONGBRIDGE_CLIENT_ID: 'your_longbridge_client_id',
    });

    expect(error).not.toBeNull();
    const validationError = error as { missingFields?: ReadonlyArray<string> };
    expect(validationError.missingFields).toContain('LONGBRIDGE_CLIENT_ID');
  });

  it('rejects an invalid callback port', async () => {
    const error = await validateEnv({
      LONGBRIDGE_AUTH_MODE: 'oauth',
      LONGBRIDGE_CLIENT_ID: 'client-id',
      LONGBRIDGE_CALLBACK_PORT: '70000',
    });

    expect(error).not.toBeNull();
    const validationError = error as { missingFields?: ReadonlyArray<string> };
    expect(validationError.missingFields).toContain('LONGBRIDGE_CALLBACK_PORT');
  });

  it('rejects invalid sdk extra config values', async () => {
    const error = await validateEnv({
      LONGBRIDGE_AUTH_MODE: 'oauth',
      LONGBRIDGE_CLIENT_ID: 'client-id',
      LONGBRIDGE_HTTP_URL: 'not-a-url',
      LONGBRIDGE_LANGUAGE: 'fr',
      LONGBRIDGE_PUSH_CANDLESTICK_MODE: 'streaming',
      LONGBRIDGE_ENABLE_OVERNIGHT: 'maybe',
      LONGBRIDGE_PRINT_QUOTE_PACKAGES: 'sometimes',
    });

    expect(error).not.toBeNull();
    const validationError = error as { missingFields?: ReadonlyArray<string> };
    expect(validationError.missingFields).toEqual(
      expect.arrayContaining([
        'LONGBRIDGE_HTTP_URL',
        'LONGBRIDGE_LANGUAGE',
        'LONGBRIDGE_PUSH_CANDLESTICK_MODE',
        'LONGBRIDGE_ENABLE_OVERNIGHT',
        'LONGBRIDGE_PRINT_QUOTE_PACKAGES',
      ]),
    );
  });

  it('accepts a complete apikey config', async () => {
    const error = await validateEnv({
      LONGBRIDGE_AUTH_MODE: 'apikey',
      LONGBRIDGE_APP_KEY: 'app-key',
      LONGBRIDGE_APP_SECRET: 'app-secret',
      LONGBRIDGE_ACCESS_TOKEN: 'access-token',
    });

    expect(error).toBeNull();
  });

  it('rejects missing apikey fields individually', async () => {
    const error = await validateEnv({
      LONGBRIDGE_AUTH_MODE: 'apikey',
      LONGBRIDGE_APP_KEY: 'app-key',
      LONGBRIDGE_APP_SECRET: 'app-secret',
    });

    expect(error).not.toBeNull();
    const validationError = error as { missingFields?: ReadonlyArray<string> };
    expect(validationError.missingFields).toContain('LONGBRIDGE_ACCESS_TOKEN');
  });

  it('treats apikey placeholder values from .env.example as missing config', async () => {
    const error = await validateEnv({
      LONGBRIDGE_AUTH_MODE: 'apikey',
      LONGBRIDGE_APP_KEY: 'your_longbridge_app_key',
      LONGBRIDGE_APP_SECRET: 'your_longbridge_app_secret',
      LONGBRIDGE_ACCESS_TOKEN: 'your_longbridge_access_token',
    });

    expect(error).not.toBeNull();
    const validationError = error as { missingFields?: ReadonlyArray<string> };
    expect(validationError.missingFields).toEqual(
      expect.arrayContaining([
        'LONGBRIDGE_APP_KEY',
        'LONGBRIDGE_APP_SECRET',
        'LONGBRIDGE_ACCESS_TOKEN',
      ]),
    );
  });
});

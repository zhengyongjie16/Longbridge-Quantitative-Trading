/**
 * apiFailure 工具业务测试
 *
 * 场景意图：锁定外部 API 请求失败与内部程序错误的分类边界。
 */
import { describe, expect, it } from 'bun:test';

import {
  createExternalApiAggregateRequestError,
  createExternalApiRequestError,
  isAllExternalApiRequestErrors,
  isExternalApiRequestError,
  wrapExternalApiRequest,
} from '../../src/utils/apiFailure/index.js';

describe('apiFailure boundary', () => {
  it('wraps repeated request failures as ExternalApiRequestError', async () => {
    let attempts = 0;

    let error: unknown = null;
    try {
      await wrapExternalApiRequest({
        operation: 'test.api',
        request: async () => {
          attempts += 1;
          throw new Error('network unavailable');
        },
        retryConfig: {
          retries: 1,
          delayMs: 0,
        },
      });
    } catch (err) {
      error = err;
    }

    expect(attempts).toBe(2);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('ExternalApiRequestError');
  });

  it('does not wrap errors rejected by caller retry predicate', async () => {
    let attempts = 0;

    let error: unknown = null;
    try {
      await wrapExternalApiRequest({
        operation: 'test.business-error',
        request: async () => {
          attempts += 1;
          throw new Error('business rejection');
        },
        shouldRetry: () => false,
      });
    } catch (err) {
      error = err;
    }

    expect(attempts).toBe(1);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('Error');
    expect((error as Error).message).toBe('business rejection');
  });

  it('does not wrap TypeError as ExternalApiRequestError', async () => {
    let attempts = 0;

    let error: unknown = null;
    try {
      await wrapExternalApiRequest({
        operation: 'test.contract',
        request: async () => {
          attempts += 1;
          throw new TypeError('contract broken');
        },
      });
    } catch (err) {
      error = err;
    }

    expect(attempts).toBe(1);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe('contract broken');
  });

  it('rejects structurally similar errors with invalid operation or attempts', () => {
    const fake = Object.assign(new Error('fake'), {
      name: 'ExternalApiRequestError',
      operation: 123,
      attempts: '1',
    });

    expect(isExternalApiRequestError(fake)).toBeFalse();
  });

  it('rejects structurally valid fake ExternalApiRequestError objects', () => {
    const fake = Object.assign(new Error('internal failure with fake fields'), {
      name: 'ExternalApiRequestError',
      operation: 'TradeContext.accountBalance',
      attempts: 1,
    });

    expect(isExternalApiRequestError(fake)).toBeFalse();
  });

  it('rejects fake ExternalApiRequestError objects with forged string brand', () => {
    const fake = Object.assign(new Error('internal failure with fake fields'), {
      name: 'ExternalApiRequestError',
      operation: 'TradeContext.accountBalance',
      attempts: 1,
      __externalApiRequestErrorBrand: true,
    });

    expect(isExternalApiRequestError(fake)).toBeFalse();
  });

  it('rejects errors that copy all properties from a real ExternalApiRequestError', () => {
    const real = createExternalApiRequestError({
      operation: 'TradeContext.accountBalance',
      attempts: 1,
      cause: new Error('network'),
    });
    const fake = Object.defineProperties(
      new Error('copied internal failure'),
      Object.getOwnPropertyDescriptors(real),
    );

    expect(isExternalApiRequestError(fake)).toBeFalse();
  });

  it('classifies aggregate external API failures as ExternalApiRequestError', () => {
    const first = createExternalApiRequestError({
      operation: 'QuoteContext.unsubscribe.quote.reset',
      attempts: 2,
      cause: new Error('quote unavailable'),
    });
    const second = createExternalApiRequestError({
      operation: 'QuoteContext.unsubscribeCandlesticks.reset',
      attempts: 2,
      cause: new Error('kline unavailable'),
    });

    const aggregate = createExternalApiAggregateRequestError({
      operation: 'QuoteContext.resetRuntimeSubscriptionsAndCaches',
      attempts: 1,
      causes: [first, second],
    });

    expect(isExternalApiRequestError(aggregate)).toBeTrue();
    expect(aggregate).toBeInstanceOf(AggregateError);
    expect(isAllExternalApiRequestErrors([first, second])).toBeTrue();
    expect(isAllExternalApiRequestErrors([first, new Error('internal')])).toBeFalse();
  });
});

import { describe, expect, it } from 'bun:test';

import { resolveQuoteReadinessForRequirement } from '../../src/utils/quoteRetry/index.js';
import type { Quote } from '../../src/types/quote.js';

function createQuote(params: Partial<Quote> = {}): Quote {
  return {
    symbol: 'BULL.HK',
    name: '测试牛证',
    price: 1.23,
    prevClose: 1.2,
    timestamp: Date.parse('2026-05-10T01:30:00.000Z'),
    ...params,
  };
}

describe('quoteRetry readiness classification', () => {
  it('classifies missing quote as MISSING', () => {
    expect(resolveQuoteReadinessForRequirement({ quote: null, requirement: 'PRICE' })).toBe(
      'MISSING',
    );
  });

  it('classifies invalid price separately from missing quote', () => {
    expect(
      resolveQuoteReadinessForRequirement({
        quote: createQuote({ price: 0 }),
        requirement: 'PRICE',
      }),
    ).toBe('INVALID_PRICE');

    expect(
      resolveQuoteReadinessForRequirement({
        quote: createQuote({ price: -1 }),
        requirement: 'PRICE',
      }),
    ).toBe('INVALID_PRICE');
  });

  it('classifies ready price-only quotes as READY', () => {
    expect(
      resolveQuoteReadinessForRequirement({ quote: createQuote(), requirement: 'PRICE' }),
    ).toBe('READY');
  });

  it('classifies missing and invalid lot size for price-and-lot-size requirement', () => {
    expect(
      resolveQuoteReadinessForRequirement({
        quote: createQuote(),
        requirement: 'PRICE_AND_LOT_SIZE',
      }),
    ).toBe('MISSING_LOT_SIZE');

    expect(
      resolveQuoteReadinessForRequirement({
        quote: createQuote({ lotSize: 0 }),
        requirement: 'PRICE_AND_LOT_SIZE',
      }),
    ).toBe('INVALID_LOT_SIZE');
  });

  it('classifies price-and-lot-size quote as READY only when both fields are valid', () => {
    expect(
      resolveQuoteReadinessForRequirement({
        quote: createQuote({ lotSize: 500 }),
        requirement: 'PRICE_AND_LOT_SIZE',
      }),
    ).toBe('READY');
  });
});

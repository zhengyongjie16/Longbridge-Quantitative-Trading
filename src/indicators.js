const toNumber = (value) =>
  typeof value === "number" ? value : Number(value ?? 0);

const safeDivide = (numerator, denominator, fallback = 0) =>
  denominator === 0 ? fallback : numerator / denominator;

export function calculateRSI(closes, period) {
  if (!closes || closes.length <= period) {
    return null;
  }

  let gains = 0;
  let losses = 0;
  const slice = closes.slice(-period - 1);
  for (let i = 1; i < slice.length; i += 1) {
    const diff = slice[i] - slice[i - 1];
    if (diff >= 0) {
      gains += diff;
    } else {
      losses -= diff;
    }
  }

  if (losses === 0) {
    return 100;
  }

  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}

export function calculateVWAP(candles) {
  if (!candles || candles.length === 0) {
    return null;
  }

  let totalValue = 0;
  let totalVolume = 0;

  for (const candle of candles) {
    const close = toNumber(candle.close);
    const volume = toNumber(candle.volume);
    totalValue += close * volume;
    totalVolume += volume;
  }

  return safeDivide(totalValue, totalVolume, toNumber(candles.at(-1)?.close));
}

export function calculateKDJ(candles, period = 9) {
  if (!candles || candles.length < period) {
    return { k: null, d: null, j: null };
  }

  let k = 50;
  let d = 50;

  for (let i = period - 1; i < candles.length; i += 1) {
    const window = candles.slice(i - period + 1, i + 1);
    const highs = window.map((c) => toNumber(c.high));
    const lows = window.map((c) => toNumber(c.low));
    const close = toNumber(window.at(-1).close);
    const highestHigh = Math.max(...highs);
    const lowestLow = Math.min(...lows);
    const range = highestHigh - lowestLow || 1;
    const rsv = ((close - lowestLow) / range) * 100;
    k = (2 / 3) * k + (1 / 3) * rsv;
    d = (2 / 3) * d + (1 / 3) * k;
  }

  const j = 3 * k - 2 * d;
  return { k, d, j };
}

export function buildIndicatorSnapshot(symbol, candles) {
  if (!candles || candles.length === 0) {
    return null;
  }

  const closes = candles.map((c) => toNumber(c.close));
  return {
    symbol,
    price: closes.at(-1),
    vwap: calculateVWAP(candles),
    rsi6: calculateRSI(closes, 6),
    rsi12: calculateRSI(closes, 12),
    kdj: calculateKDJ(candles, 9),
  };
}




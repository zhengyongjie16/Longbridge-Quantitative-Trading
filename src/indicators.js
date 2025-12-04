const toNumber = (value) =>
  typeof value === "number" ? value : Number(value ?? 0);

const safeDivide = (numerator, denominator, fallback = 0) =>
  denominator === 0 ? fallback : numerator / denominator;

export function calculateRSI(closes, period) {
  if (!closes || closes.length <= period || !Number.isFinite(period) || period <= 0) {
    return null;
  }

  let gains = 0;
  let losses = 0;
  let validPairs = 0;
  const slice = closes.slice(-period - 1);
  
  for (let i = 1; i < slice.length; i += 1) {
    const current = toNumber(slice[i]);
    const previous = toNumber(slice[i - 1]);
    
    // 跳过无效数据
    if (!Number.isFinite(current) || !Number.isFinite(previous)) {
      continue;
    }
    
    const diff = current - previous;
    if (diff >= 0) {
      gains += diff;
    } else {
      losses -= diff;
    }
    validPairs++;
  }

  // 如果没有有效数据对，返回null
  if (validPairs === 0) {
    return null;
  }

  if (losses === 0) {
    return 100;
  }

  const rs = (gains / period) / (losses / period);
  const rsi = 100 - 100 / (1 + rs);
  
  // 验证RSI结果有效性
  return Number.isFinite(rsi) ? rsi : null;
}

export function calculateVWAP(candles) {
  if (!candles || candles.length === 0) {
    return null;
  }

  let totalValue = 0;
  let totalVolume = 0;
  let validCandles = 0;

  for (const candle of candles) {
    const close = toNumber(candle.close);
    const volume = toNumber(candle.volume);
    
    // 跳过无效数据
    if (!Number.isFinite(close) || !Number.isFinite(volume) || volume < 0) {
      continue;
    }
    
    totalValue += close * volume;
    totalVolume += volume;
    validCandles++;
  }

  // 如果没有有效数据，返回最后一个收盘价
  if (validCandles === 0 || totalVolume === 0) {
    const lastClose = toNumber(candles.at(-1)?.close);
    return Number.isFinite(lastClose) && lastClose > 0 ? lastClose : null;
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
    const highs = window.map((c) => toNumber(c.high)).filter(v => Number.isFinite(v));
    const lows = window.map((c) => toNumber(c.low)).filter(v => Number.isFinite(v));
    const close = toNumber(window.at(-1)?.close);
    
    // 验证数据有效性
    if (highs.length === 0 || lows.length === 0 || !Number.isFinite(close)) {
      continue; // 跳过无效数据
    }
    
    const highestHigh = Math.max(...highs);
    const lowestLow = Math.min(...lows);
    const range = highestHigh - lowestLow;
    
    // 确保range不为0或NaN
    if (!Number.isFinite(range) || range === 0) {
      continue; // 跳过无效数据
    }
    
    const rsv = ((close - lowestLow) / range) * 100;
    k = (2 / 3) * k + (1 / 3) * rsv;
    d = (2 / 3) * d + (1 / 3) * k;
  }

  const j = 3 * k - 2 * d;
  return { k, d, j };
}

/**
 * 获取特定K线位置的KDJ J值
 * @param {Array} candles K线数据数组
 * @param {number} index K线索引（从0开始，-1表示最后一根）
 * @param {number} period KDJ周期，默认9
 * @returns {number|null} KDJ J值，如果无法计算则返回null
 */
export function getKDJAt(candles, index, period = 9) {
  if (!candles || candles.length < period) {
    return null;
  }

  // 处理负数索引（从末尾开始）
  const actualIndex = index < 0 ? candles.length + index : index;
  if (actualIndex < period - 1 || actualIndex >= candles.length) {
    return null;
  }

  // 计算到指定索引为止的KDJ值
  let k = 50;
  let d = 50;

  for (let i = period - 1; i <= actualIndex; i += 1) {
    const window = candles.slice(i - period + 1, i + 1);
    const highs = window.map((c) => toNumber(c.high)).filter(v => Number.isFinite(v));
    const lows = window.map((c) => toNumber(c.low)).filter(v => Number.isFinite(v));
    const close = toNumber(window.at(-1)?.close);
    
    // 验证数据有效性
    if (highs.length === 0 || lows.length === 0 || !Number.isFinite(close)) {
      continue;
    }
    
    const highestHigh = Math.max(...highs);
    const lowestLow = Math.min(...lows);
    const range = highestHigh - lowestLow;
    
    if (!Number.isFinite(range) || range === 0) {
      continue;
    }
    
    const rsv = ((close - lowestLow) / range) * 100;
    k = (2 / 3) * k + (1 / 3) * rsv;
    d = (2 / 3) * d + (1 / 3) * k;
  }

  const j = 3 * k - 2 * d;
  return Number.isFinite(j) ? j : null;
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




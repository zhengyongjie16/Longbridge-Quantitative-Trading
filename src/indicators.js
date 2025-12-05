const toNumber = (value) =>
  typeof value === "number" ? value : Number(value ?? 0);

const safeDivide = (numerator, denominator, fallback = 0) =>
  denominator === 0 ? fallback : numerator / denominator;

/**
 * 计算RSI指标（使用EMA方式）
 * RSI的EMA计算方式：
 * 1. 计算价格变化（涨跌值）
 * 2. 分离涨幅和跌幅
 * 3. 对涨幅和跌幅分别计算EMA
 * 4. RS = EMA(涨幅) / EMA(跌幅)
 * 5. RSI = 100 - 100 / (1 + RS)
 * 
 * @param {Array<number>} closes 收盘价数组
 * @param {number} period RSI周期，默认14
 * @returns {number|null} RSI值，如果无法计算则返回null
 */
export function calculateRSI(closes, period) {
  if (!closes || closes.length <= period || !Number.isFinite(period) || period <= 0) {
    return null;
  }

  // 计算价格变化（涨跌值）
  const changes = [];
  for (let i = 1; i < closes.length; i++) {
    const current = toNumber(closes[i]);
    const previous = toNumber(closes[i - 1]);
    
    // 跳过无效数据
    if (!Number.isFinite(current) || !Number.isFinite(previous)) {
      continue;
    }
    
    const change = current - previous;
    changes.push(change);
  }

  if (changes.length < period) {
    return null;
  }

  // 分离涨幅和跌幅
  const gains = changes.map(change => Math.max(change, 0));
  const losses = changes.map(change => Math.max(-change, 0));

  // 计算涨幅和跌幅的EMA
  // 首先计算初始值（使用SMA）
  let avgGain = 0;
  let avgLoss = 0;
  let validCount = 0;
  
  for (let i = 0; i < period; i++) {
    const gain = toNumber(gains[i]);
    const loss = toNumber(losses[i]);
    
    if (Number.isFinite(gain) && Number.isFinite(loss)) {
      avgGain += gain;
      avgLoss += loss;
      validCount++;
    }
  }

  if (validCount === 0) {
    return null;
  }

  // 初始EMA值使用SMA（简单移动平均）
  // 使用validCount而不是period，确保即使有无效数据也能正确计算
  avgGain = avgGain / validCount;
  avgLoss = avgLoss / validCount;

  // 如果平均跌幅为0，RSI为100
  if (avgLoss === 0) {
    return 100;
  }

  // 使用EMA平滑计算后续的涨幅和跌幅
  const multiplier = 1 / period; // EMA平滑系数
  
  for (let i = period; i < changes.length; i++) {
    const currentGain = toNumber(gains[i]);
    const currentLoss = toNumber(losses[i]);
    
    if (Number.isFinite(currentGain) && Number.isFinite(currentLoss)) {
      // EMA公式：新EMA = (当前值 * 平滑系数) + (旧EMA * (1 - 平滑系数))
      // 或者：新EMA = 旧EMA + (当前值 - 旧EMA) * 平滑系数
      avgGain = (currentGain * multiplier) + (avgGain * (1 - multiplier));
      avgLoss = (currentLoss * multiplier) + (avgLoss * (1 - multiplier));
    }
  }

  // 如果平均跌幅为0，RSI为100
  if (avgLoss === 0) {
    return 100;
  }

  // 计算RS和RSI
  const rs = avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);
  
  // 验证RSI结果有效性
  return Number.isFinite(rsi) && rsi >= 0 && rsi <= 100 ? rsi : null;
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

/**
 * 计算指数移动平均线（EMA）
 * @param {Array<number>} values 数值数组
 * @param {number} period 周期
 * @returns {Array<number>} EMA数组
 */
function calculateEMA(values, period) {
  if (!values || values.length < period) {
    return [];
  }

  const ema = [];
  const multiplier = 2 / (period + 1);
  
  // 第一个EMA值使用SMA（简单移动平均）
  let sum = 0;
  for (let i = 0; i < period; i++) {
    const value = toNumber(values[i]);
    if (!Number.isFinite(value)) {
      return [];
    }
    sum += value;
  }
  ema[period - 1] = sum / period;

  // 后续EMA值使用公式：EMA = (当前值 - 前一日EMA) * 乘数 + 前一日EMA
  for (let i = period; i < values.length; i++) {
    const value = toNumber(values[i]);
    if (!Number.isFinite(value)) {
      return [];
    }
    ema[i] = (value - ema[i - 1]) * multiplier + ema[i - 1];
  }

  return ema;
}

/**
 * 计算MACD指标
 * @param {Array<number>} closes 收盘价数组
 * @param {number} fastPeriod 快线周期，默认12
 * @param {number} slowPeriod 慢线周期，默认26
 * @param {number} signalPeriod 信号线周期，默认9
 * @returns {Object|null} MACD对象 {dif, dea, macd}，如果无法计算则返回null
 */
export function calculateMACD(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  if (!closes || closes.length < slowPeriod + signalPeriod) {
    return null;
  }

  // 计算EMA12和EMA26
  const ema12 = calculateEMA(closes, fastPeriod);
  const ema26 = calculateEMA(closes, slowPeriod);

  if (ema12.length === 0 || ema26.length === 0) {
    return null;
  }

  // 计算DIF（快线 - 慢线）
  // DIF从两个EMA都有值的位置开始计算
  const startIndex = Math.max(fastPeriod - 1, slowPeriod - 1);
  const dif = [];
  
  for (let i = startIndex; i < closes.length; i++) {
    const difValue = ema12[i] - ema26[i];
    if (Number.isFinite(difValue)) {
      dif.push(difValue);
    } else {
      return null;
    }
  }

  if (dif.length < signalPeriod) {
    return null;
  }

  // 计算DEA（DIF的EMA，即信号线）
  const deaArray = calculateEMA(dif, signalPeriod);
  if (deaArray.length === 0) {
    return null;
  }

  // 获取最新的值
  const lastDifIndex = dif.length - 1;
  const lastDeaIndex = deaArray.length - 1;

  if (lastDifIndex < 0 || lastDeaIndex < 0) {
    return null;
  }

  const difValue = dif[lastDifIndex];
  const deaValue = deaArray[lastDeaIndex];
  
  // 计算MACD柱状图（(DIF - DEA) * 2）
  const macdValue = (difValue - deaValue) * 2;

  if (!Number.isFinite(difValue) || !Number.isFinite(deaValue) || !Number.isFinite(macdValue)) {
    return null;
  }

  return {
    dif: difValue,
    dea: deaValue,
    macd: macdValue,
  };
}

export function buildIndicatorSnapshot(symbol, candles) {
  if (!candles || candles.length === 0) {
    return null;
  }

  const closes = candles.map((c) => toNumber(c.close));
  
  // 确保closes数组有效且至少有一个有效值
  const validCloses = closes.filter(c => Number.isFinite(c) && c > 0);
  if (validCloses.length === 0) {
    return null;
  }
  
  const lastPrice = closes.at(-1);
  const validPrice = Number.isFinite(lastPrice) && lastPrice > 0 ? lastPrice : null;
  
  return {
    symbol,
    price: validPrice,
    vwap: calculateVWAP(candles),
    rsi6: calculateRSI(closes, 6),
    rsi12: calculateRSI(closes, 12),
    kdj: calculateKDJ(candles, 9),
    macd: calculateMACD(closes),
  };
}




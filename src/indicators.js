const toNumber = (value) =>
  typeof value === "number" ? value : Number(value ?? 0);

const safeDivide = (numerator, denominator, fallback = 0) =>
  denominator === 0 ? fallback : numerator / denominator;

/**
 * ============================================================================
 * RSI（相对强弱指标）计算函数
 * ============================================================================
 *
 * 【调用位置】
 *   - buildIndicatorSnapshot() 函数中调用
 *   - 用于计算 rsi6（周期6）和 rsi12（周期12）
 *
 * 【计算方法：EMA方式（指数移动平均）】
 *   使用指数移动平均（EMA）而非简单移动平均（SMA）来计算RSI，
 *   使得近期价格变化对RSI值的影响更大。
 *
 * 【计算步骤】
 *   1. 计算价格变化（涨跌值）
 *      change[i] = close[i] - close[i-1]
 *
 *   2. 分离涨幅和跌幅
 *      gains[i] = max(change[i], 0)      // 涨幅（正数或0）
 *      losses[i] = max(-change[i], 0)   // 跌幅（正数或0）
 *
 *   3. 计算初始平均值（使用SMA作为EMA的初始值）
 *      avgGain = sum(gains[0..period-1]) / period
 *      avgLoss = sum(losses[0..period-1]) / period
 *
 *   4. 使用EMA平滑计算后续的涨幅和跌幅
 *      multiplier = 1 / period  // EMA平滑系数
 *      avgGain = currentGain * multiplier + avgGain * (1 - multiplier)
 *      avgLoss = currentLoss * multiplier + avgLoss * (1 - multiplier)
 *
 *   5. 计算RS（相对强度）和RSI
 *      RS = avgGain / avgLoss
 *      RSI = 100 - 100 / (1 + RS)
 *
 * 【公式说明】
 *   - RSI值范围：0-100
 *   - RSI > 70：通常认为超买
 *   - RSI < 30：通常认为超卖
 *   - 本策略使用：RSI6 > 80 或 RSI12 > 80 作为卖出信号
 *                 RSI6 < 20 或 RSI12 < 20 作为买入信号
 *
 * 【注意事项】
 *   - 如果 avgLoss = 0（没有跌幅），直接返回 RSI = 100
 *   - 平滑系数使用 1/period，而非标准EMA的 2/(period+1)
 *   - 这会使平滑程度更高，对近期数据敏感度略低
 *
 * @param {Array<number>} closes 收盘价数组，按时间顺序排列
 * @param {number} period RSI周期，例如：6（RSI6）或 12（RSI12）
 * @returns {number|null} RSI值（0-100），如果无法计算则返回null
 */
export function calculateRSI(closes, period) {
  if (
    !closes ||
    closes.length <= period ||
    !Number.isFinite(period) ||
    period <= 0
  ) {
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
  const gains = changes.map((change) => Math.max(change, 0));
  const losses = changes.map((change) => Math.max(-change, 0));

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
      avgGain = currentGain * multiplier + avgGain * (1 - multiplier);
      avgLoss = currentLoss * multiplier + avgLoss * (1 - multiplier);
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

/**
 * ============================================================================
 * KDJ（随机指标）计算函数
 * ============================================================================

 *
 * 【调用位置】
 *   - buildIndicatorSnapshot() 函数中调用
 *   - 用于计算 kdj 对象，包含 k、d、j 三个值
 *
 * 【计算方法：标准KDJ公式】
 *   KDJ指标由K值（快速随机指标）、D值（慢速随机指标）和J值组成。
 *   通过计算当前收盘价在最近N根K线中的相对位置来判断超买超卖。
 *
 * 【计算步骤】
 *   1. 计算RSV（未成熟随机值，Raw Stochastic Value）
 *      取最近 period（默认9）根K线的窗口：
 *      window = candles[i-period+1 .. i]
 *      highestHigh = max(window中的high值)
 *      lowestLow = min(window中的low值)
 *      range = highestHigh - lowestLow
 *
 *      RSV = ((close - lowestLow) / range) * 100
 *      RSV范围：0-100，表示当前收盘价在窗口内最高价和最低价之间的位置
 *
 *   2. 计算K值（快速随机指标）
 *      K = (2/3) * 前一个K值 + (1/3) * RSV
 *      - 初始K值 = 50
 *      - 平滑系数：2/3（旧值权重）和 1/3（新值权重）
 *      - K值范围：0-100
 *
 *   3. 计算D值（慢速随机指标）
 *      D = (2/3) * 前一个D值 + (1/3) * K值
 *      - 初始D值 = 50
 *      - 对K值再次平滑，反应更慢
 *      - D值范围：0-100
 *
 *   4. 计算J值
 *      J = 3 * K - 2 * D
 *      - J值可能超出0-100范围（可能为负数或大于100）
 *      - J值变化最快，最敏感
 *
 * 【公式说明】
 *   - K值：快速随机指标，反应较快
 *   - D值：慢速随机指标，反应较慢，对K值再次平滑
 *   - J值：最敏感的指标，变化最快
 *
 *   - K > 80 或 D > 80：通常认为超买
 *   - K < 20 或 D < 20：通常认为超卖
 *   - J > 100：超买信号
 *   - J < 0：超卖信号
 *
 *   本策略使用：
 *     - KDJ.D > 80 且 KDJ.J > 100：卖出做多标的信号
 *     - KDJ.D < 20 且 KDJ.J < 0：卖出做空标的信号
 *     - KDJ.D < 20 且 KDJ.J < -1：买入做多标的信号
 *
 * 【注意事项】
 *   - 默认周期 period = 9
 *   - 如果窗口内最高价等于最低价（range = 0），会跳过该数据点
 *   - 初始K和D值设为50，需要一定周期才能稳定
 *   - 使用滑动窗口逐根K线计算，最终返回最后一根K线的KDJ值
 *
 * @param {Array<Object>} candles K线数据数组，每根K线包含 {high, low, close} 等字段
 * @param {number} period KDJ周期，默认9
 * @returns {Object} 包含 k、d、j 三个值的对象
 *   - k: K值（0-100）
 *   - d: D值（0-100）
 *   - j: J值（可能超出0-100范围）
 *   如果无法计算，返回 {k: null, d: null, j: null}
 */
export function calculateKDJ(candles, period = 9) {
  if (!candles || candles.length < period) {
    return { k: null, d: null, j: null };
  }

  // 初始化K和D值为50（标准初始值）
  let k = 50;
  let d = 50;

  // 逐根K线计算，使用滑动窗口
  for (let i = period - 1; i < candles.length; i += 1) {
    // 获取当前窗口（最近period根K线）
    const window = candles.slice(i - period + 1, i + 1);

    // 提取窗口内的最高价和最低价
    const highs = window
      .map((c) => toNumber(c.high))
      .filter((v) => Number.isFinite(v));
    const lows = window
      .map((c) => toNumber(c.low))
      .filter((v) => Number.isFinite(v));
    const close = toNumber(window.at(-1)?.close);

    // 验证数据有效性
    if (highs.length === 0 || lows.length === 0 || !Number.isFinite(close)) {
      continue; // 跳过无效数据
    }

    // 计算窗口内的最高价和最低价
    const highestHigh = Math.max(...highs);
    const lowestLow = Math.min(...lows);
    const range = highestHigh - lowestLow;

    // 确保range不为0或NaN（如果最高价等于最低价，跳过）
    if (!Number.isFinite(range) || range === 0) {
      continue; // 跳过无效数据
    }

    // 步骤1：计算RSV（未成熟随机值）
    // RSV = ((收盘价 - 最低价) / (最高价 - 最低价)) * 100
    const rsv = ((close - lowestLow) / range) * 100;

    // 步骤2：计算K值（快速随机指标）
    // K = (2/3) * 前一个K值 + (1/3) * RSV
    k = (2 / 3) * k + (1 / 3) * rsv;

    // 步骤3：计算D值（慢速随机指标）
    // D = (2/3) * 前一个D值 + (1/3) * K值
    d = (2 / 3) * d + (1 / 3) * k;
  }

  // 步骤4：计算J值
  // J = 3 * K - 2 * D
  const j = 3 * k - 2 * d;

  return { k, d, j };
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
export function calculateMACD(
  closes,
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9
) {
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

  if (
    !Number.isFinite(difValue) ||
    !Number.isFinite(deaValue) ||
    !Number.isFinite(macdValue)
  ) {
    return null;
  }

  return {
    dif: difValue,
    dea: deaValue,
    macd: macdValue,
  };
}

/**
 * ============================================================================
 * 构建指标快照（统一计算所有技术指标）
 * ============================================================================
 
 *
 * 【调用位置】
 *   - src/index.js ：buildIndicatorSnapshot(monitorSymbol, monitorCandles)
 *   - 用于计算监控标的的所有技术指标，供策略使用
 *
 * 【功能说明】
 *   统一计算并返回指定标的的所有技术指标，包括：
 *   - price: 最新收盘价
 *   - vwap: 成交量加权平均价
 *   - rsi6: 6周期RSI指标
 *   - rsi12: 12周期RSI指标
 *   - kdj: KDJ指标（包含k、d、j三个值，周期9）
 *   - macd: MACD指标（包含dif、dea、macd三个值）
 *
 * 【计算顺序】
 *   1. 提取收盘价数组
 *   2. 计算VWAP（需要完整的K线数据）
 *   3. 计算RSI6和RSI12（需要收盘价数组）
 *   4. 计算KDJ（需要完整的K线数据，包含high、low、close）
 *   5. 计算MACD（需要收盘价数组）
 *
 * @param {string} symbol 标的代码
 * @param {Array<Object>} candles K线数据数组，每根K线包含 {open, high, low, close, volume} 等字段
 * @returns {Object|null} 指标快照对象，包含所有计算好的指标值
 *   如果无法计算，返回 null
 */
export function buildIndicatorSnapshot(symbol, candles) {
  if (!candles || candles.length === 0) {
    return null;
  }

  // 提取收盘价数组（用于RSI和MACD计算）
  const closes = candles.map((c) => toNumber(c.close));

  // 确保closes数组有效且至少有一个有效值
  const validCloses = closes.filter((c) => Number.isFinite(c) && c > 0);
  if (validCloses.length === 0) {
    return null;
  }

  // 获取最新收盘价
  const lastPrice = closes.at(-1);
  const validPrice =
    Number.isFinite(lastPrice) && lastPrice > 0 ? lastPrice : null;

  // 统一计算所有指标并返回
  return {
    symbol,
    price: validPrice, // 最新收盘价
    vwap: calculateVWAP(candles), // 成交量加权平均价
    rsi6: calculateRSI(closes, 6), // 6周期RSI
    rsi12: calculateRSI(closes, 12), // 12周期RSI
    kdj: calculateKDJ(candles, 9), // KDJ指标
    macd: calculateMACD(closes), // MACD指标
  };
}

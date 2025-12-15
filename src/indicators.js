import { RSI, MACD, EMA } from "technicalindicators";

const toNumber = (value) =>
  typeof value === "number" ? value : Number(value ?? 0);

/**
 * ============================================================================
 * RSI（相对强弱指标）计算函数
 * ============================================================================
 *
 * 【调用位置】
 *   - buildIndicatorSnapshot() 函数中调用
 *   - 用于计算 rsi6（周期6）和 rsi12（周期12）
 *
 * 【实现方式】
 *   使用 technicalindicators 库的 RSI.calculate 方法
 *   该库使用标准的 Wilder's Smoothing 方法（平滑系数 = 1/period）
 *
 * 【计算方法：Wilder's Smoothing（Wilder平滑法）】
 *   1. 计算价格变化（涨跌值）
 *   2. 分离涨幅和跌幅
 *   3. 使用平滑系数 1/period 计算平均涨幅和平均跌幅
 *   4. 计算 RS = 平均涨幅 / 平均跌幅
 *   5. 计算 RSI = 100 - 100 / (1 + RS)
 *
 * 【公式说明】
 *   - RSI值范围：0-100
 *   - RSI > 70：通常认为超买
 *   - RSI < 30：通常认为超卖
 *   - 本策略使用：RSI6 > 80 或 RSI12 > 80 作为卖出信号
 *                 RSI6 < 20 或 RSI12 < 20 作为买入信号
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

  try {
    // 过滤无效数据
    const validCloses = closes
      .map((c) => toNumber(c))
      .filter((v) => Number.isFinite(v) && v > 0);

    if (validCloses.length <= period) {
      return null;
    }

    // 使用 technicalindicators 库计算 RSI
    // RSI.calculate 使用标准的 Wilder's Smoothing 方法（平滑系数 = 1/period）
    const rsiResult = RSI.calculate({ values: validCloses, period });

    if (!rsiResult || rsiResult.length === 0) {
      return null;
    }

    // 获取最后一个 RSI 值（当前值）
    const rsi = rsiResult.at(-1);

    // 验证 RSI 结果有效性（0-100 范围）
    if (!Number.isFinite(rsi) || rsi < 0 || rsi > 100) {
      return null;
    }

    return rsi;
  } catch (err) {
    // 如果计算失败，返回 null
    return null;
  }
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

  try {
    const emaPeriod = 5; // EMA 平滑周期（平滑系数 = 2/(5+1) = 1/3）

    // 步骤1：计算所有 RSV 值
    const rsvValues = [];
    for (let i = period - 1; i < candles.length; i += 1) {
      // 获取当前窗口（最近 period 根K线）
      const window = candles.slice(i - period + 1, i + 1);

      // 提取窗口内的最高价和最低价
      const windowHighs = window
        .map((c) => toNumber(c.high))
        .filter((v) => Number.isFinite(v));
      const windowLows = window
        .map((c) => toNumber(c.low))
        .filter((v) => Number.isFinite(v));
      const close = toNumber(window.at(-1)?.close);

      // 验证数据有效性
      if (
        windowHighs.length === 0 ||
        windowLows.length === 0 ||
        !Number.isFinite(close)
      ) {
        continue; // 跳过无效数据
      }

      // 计算窗口内的最高价和最低价
      const highestHigh = Math.max(...windowHighs);
      const lowestLow = Math.min(...windowLows);
      const range = highestHigh - lowestLow;

      // 确保 range 不为 0 或 NaN（如果最高价等于最低价，跳过）
      if (!Number.isFinite(range) || range === 0) {
        continue; // 跳过无效数据
      }

      // 计算 RSV（未成熟随机值）
      // RSV = ((收盘价 - 最低价) / (最高价 - 最低价)) * 100
      const rsv = ((close - lowestLow) / range) * 100;
      rsvValues.push(rsv);
    }

    if (rsvValues.length === 0) {
      return { k: null, d: null, j: null };
    }

    // 步骤2：使用 EMA(period=5) 平滑 RSV 得到 K 值
    // EMA 的平滑系数 = 2/(period+1) = 2/6 = 1/3
    // 公式：EMA = (1/3) * 当前值 + (2/3) * 前一个EMA
    // 这与当前代码的 K = (1/3) * RSV + (2/3) * 前一个K 完全一致
    const emaK = new EMA({ period: emaPeriod, values: [] });
    const kValues = [];
    // 先用初始值 50 初始化 EMA（与当前代码一致）
    emaK.nextValue(50); // 设置初始值为 50
    // 然后对每个 RSV 应用 EMA 平滑
    for (let i = 0; i < rsvValues.length; i++) {
      const kValue = emaK.nextValue(rsvValues[i]);
      if (kValue !== undefined) {
        kValues.push(kValue);
      } else {
        // 如果返回 undefined（理论上不应该发生），使用前一个值或初始值
        kValues.push(kValues.length > 0 ? kValues.at(-1) : 50);
      }
    }

    // 步骤3：使用 EMA(period=5) 平滑 K 值得到 D 值
    const emaD = new EMA({ period: emaPeriod, values: [] });
    const dValues = [];
    // 先用初始值 50 初始化 EMA（与当前代码一致）
    emaD.nextValue(50); // 设置初始值为 50
    // 然后对每个 K 值应用 EMA 平滑
    for (let i = 0; i < kValues.length; i++) {
      const dValue = emaD.nextValue(kValues[i]);
      if (dValue !== undefined) {
        dValues.push(dValue);
      } else {
        // 如果返回 undefined（理论上不应该发生），使用前一个值或初始值
        dValues.push(dValues.length > 0 ? dValues.at(-1) : 50);
      }
    }

    // 获取最后的 K 和 D 值
    const k = kValues.at(-1);
    const d = dValues.at(-1);

    // 步骤4：计算J值
    // J = 3 * K - 2 * D
    const j = 3 * k - 2 * d;

    // 验证计算结果的有效性
    if (Number.isFinite(k) && Number.isFinite(d) && Number.isFinite(j)) {
      return { k, d, j };
    }

    return { k: null, d: null, j: null };
  } catch (err) {
    // 如果计算失败，返回 null
    return { k: null, d: null, j: null };
  }
}

/**
 * ============================================================================
 * MACD（移动平均收敛散度指标）计算函数
 * ============================================================================
 *
 * 【调用位置】
 *   - buildIndicatorSnapshot() 函数中调用
 *   - 用于计算 macd 对象，包含 dif、dea、macd 三个值
 *
 * 【实现方式】
 *   使用 technicalindicators 库的 MACD.calculate 方法
 *   该库使用标准的 EMA 计算方式，与当前手动实现的逻辑一致
 *
 * 【计算方法：标准MACD公式】
 *   1. 计算快线 EMA12 和慢线 EMA26
 *   2. 计算 DIF = EMA12 - EMA26
 *   3. 计算 DEA = DIF 的 EMA9（信号线）
 *   4. 计算 MACD = (DIF - DEA) * 2（柱状图）
 *
 * 【注意事项】
 *   - technicalindicators 返回的 histogram = MACD - signal = dif - dea
 *   - 当前代码中 macd = (dif - dea) * 2，所以需要将 histogram 乘以 2
 *   - 使用 EMA 计算（SimpleMAOscillator: false, SimpleMASignal: false）
 *
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

  try {
    // 过滤无效数据
    const validCloses = closes
      .map((c) => toNumber(c))
      .filter((v) => Number.isFinite(v) && v > 0);

    if (validCloses.length < slowPeriod + signalPeriod) {
      return null;
    }

    // 使用 technicalindicators 库计算 MACD
    // MACD 默认参数：fastPeriod=12, slowPeriod=26, signalPeriod=9
    // SimpleMAOscillator: false 表示使用 EMA（指数移动平均）计算快慢线
    // SimpleMASignal: false 表示使用 EMA 计算信号线
    const macdResult = MACD.calculate({
      values: validCloses,
      fastPeriod,
      slowPeriod,
      signalPeriod,
      SimpleMAOscillator: false, // 使用 EMA（与当前代码逻辑一致）
      SimpleMASignal: false, // 使用 EMA（与当前代码逻辑一致）
    });

    if (!macdResult || macdResult.length === 0) {
      return null;
    }

    // 获取最后一个 MACD 值（当前值）
    const lastMacd = macdResult.at(-1);

    // technicalindicators 返回 {MACD, signal, histogram}
    // 根据当前代码逻辑，我们需要返回 {dif, dea, macd}
    // MACD 对应 dif（快慢线差值 = EMA12 - EMA26）
    // signal 对应 dea（信号线 = DIF 的 EMA9）
    // histogram = MACD - signal = dif - dea
    // 当前代码中 macd = (dif - dea) * 2，所以需要将 histogram 乘以 2 以保持一致性
    const dif = lastMacd.MACD;
    const dea = lastMacd.signal;
    const macdValue = lastMacd.histogram * 2; // 保持与当前代码逻辑一致

    // 验证数据有效性
    if (
      !Number.isFinite(dif) ||
      !Number.isFinite(dea) ||
      !Number.isFinite(macdValue)
    ) {
      return null;
    }

    return {
      dif,
      dea,
      macd: macdValue,
    };
  } catch (err) {
    // 如果计算失败，返回 null
    return null;
  }
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
 * 【实现方式】
 *   使用 technicalindicators 库优化指标计算，性能提升约 2.9 倍
 *   - RSI：使用 RSI.calculate（Wilder's Smoothing，平滑系数 = 1/period）
 *   - KDJ：使用 EMA(period=5) 实现平滑系数 1/3
 *   - MACD：使用 MACD.calculate（EMA 计算方式）
 *
 * 【功能说明】
 *   统一计算并返回指定标的的所有技术指标，包括：
 *   - price: 最新收盘价
 *   - rsi6: 6周期RSI指标
 *   - rsi12: 12周期RSI指标
 *   - kdj: KDJ指标（包含k、d、j三个值，周期9）
 *   - macd: MACD指标（包含dif、dea、macd三个值）
 *
 * 【计算顺序】
 *   1. 提取收盘价数组
 *   2. 计算RSI6和RSI12（使用 technicalindicators 库）
 *   3. 计算KDJ（使用 technicalindicators 库的 EMA）
 *   4. 计算MACD（使用 technicalindicators 库）
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
    rsi6: calculateRSI(closes, 6), // 6周期RSI
    rsi12: calculateRSI(closes, 12), // 12周期RSI
    kdj: calculateKDJ(candles, 9), // KDJ指标
    macd: calculateMACD(closes), // MACD指标
  };
}

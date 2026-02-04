/**
 * 测试5: 技术指标计算性能测试
 * 模拟项目中的实际计算逻辑
 */
import { getRuntime, getVersion, measure, printResult, printHeader } from './utils.js';

printHeader(`技术指标计算性能测试 - ${getRuntime()} ${getVersion()}`);

const results = [];

// 生成模拟K线数据
function generateCandles(count) {
  const candles = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const change = (Math.random() - 0.5) * 2;
    price = Math.max(1, price + change);
    const high = price + Math.random() * 2;
    const low = price - Math.random() * 2;
    candles.push({
      open: price,
      high: high,
      low: Math.max(0.1, low),
      close: price + (Math.random() - 0.5),
      volume: Math.floor(Math.random() * 1000000)
    });
  }
  return candles;
}

// EMA计算 (指数移动平均)
function calculateEMA(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

// RSI计算
function calculateRSI(closes, period = 14) {
  if (closes.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (change < 0 ? -change : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// MACD计算
function calculateMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;
  const emaFast = [];
  const emaSlow = [];
  const kFast = 2 / (fast + 1);
  const kSlow = 2 / (slow + 1);

  let emaF = closes.slice(0, fast).reduce((a, b) => a + b, 0) / fast;
  let emaS = closes.slice(0, slow).reduce((a, b) => a + b, 0) / slow;

  for (let i = 0; i < closes.length; i++) {
    if (i >= fast) emaF = closes[i] * kFast + emaF * (1 - kFast);
    if (i >= slow) emaS = closes[i] * kSlow + emaS * (1 - kSlow);
    emaFast.push(emaF);
    emaSlow.push(emaS);
  }

  const dif = [];
  for (let i = slow - 1; i < closes.length; i++) {
    dif.push(emaFast[i] - emaSlow[i]);
  }

  const kSignal = 2 / (signal + 1);
  let dea = dif.slice(0, signal).reduce((a, b) => a + b, 0) / signal;
  for (let i = signal; i < dif.length; i++) {
    dea = dif[i] * kSignal + dea * (1 - kSignal);
  }

  return { dif: dif[dif.length - 1], dea, macd: (dif[dif.length - 1] - dea) * 2 };
}

// KDJ计算
function calculateKDJ(candles, period = 9) {
  if (candles.length < period) return null;
  const rsvValues = [];

  for (let i = period - 1; i < candles.length; i++) {
    let highestHigh = -Infinity;
    let lowestLow = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      highestHigh = Math.max(highestHigh, candles[j].high);
      lowestLow = Math.min(lowestLow, candles[j].low);
    }
    const range = highestHigh - lowestLow;
    if (range === 0) continue;
    rsvValues.push(((candles[i].close - lowestLow) / range) * 100);
  }

  let k = 50, d = 50;
  const alpha = 1 / 3;
  for (const rsv of rsvValues) {
    k = (1 - alpha) * k + alpha * rsv;
    d = (1 - alpha) * d + alpha * k;
  }
  return { k, d, j: 3 * k - 2 * d };
}

const candles500 = generateCandles(500);
const candles2000 = generateCandles(2000);
const candles10000 = generateCandles(10000);
const closes500 = candles500.map(c => c.close);
const closes2000 = candles2000.map(c => c.close);
const closes10000 = candles10000.map(c => c.close);

console.log('\n数据规模: 500条, 2000条, 10000条K线');

// 测试1: RSI计算 (500条)
results.push(measure('RSI计算 (500条) x1000', () => {
  for (let i = 0; i < 1000; i++) {
    calculateRSI(closes500, 14);
  }
}, 5));

// 测试2: RSI计算 (10000条)
results.push(measure('RSI计算 (10000条) x100', () => {
  for (let i = 0; i < 100; i++) {
    calculateRSI(closes10000, 14);
  }
}, 5));

// 测试3: MACD计算 (500条)
results.push(measure('MACD计算 (500条) x1000', () => {
  for (let i = 0; i < 1000; i++) {
    calculateMACD(closes500);
  }
}, 5));

// 测试4: MACD计算 (10000条)
results.push(measure('MACD计算 (10000条) x100', () => {
  for (let i = 0; i < 100; i++) {
    calculateMACD(closes10000);
  }
}, 5));

// 测试5: KDJ计算 (500条)
results.push(measure('KDJ计算 (500条) x1000', () => {
  for (let i = 0; i < 1000; i++) {
    calculateKDJ(candles500);
  }
}, 5));

// 测试6: KDJ计算 (10000条)
results.push(measure('KDJ计算 (10000条) x100', () => {
  for (let i = 0; i < 100; i++) {
    calculateKDJ(candles10000);
  }
}, 5));

// 测试7: EMA计算 (10000条)
results.push(measure('EMA计算 (10000条) x500', () => {
  for (let i = 0; i < 500; i++) {
    calculateEMA(closes10000, 20);
  }
}, 5));

// 测试8: 组合指标计算 (模拟实际场景)
results.push(measure('组合指标计算 (RSI+MACD+KDJ) x500', () => {
  for (let i = 0; i < 500; i++) {
    calculateRSI(closes2000, 6);
    calculateRSI(closes2000, 14);
    calculateMACD(closes2000);
    calculateKDJ(candles2000);
  }
}, 5));

// 打印结果
console.log('\n测试结果:');
results.forEach(printResult);

console.log('\n--- JSON结果 ---');
console.log(JSON.stringify({
  runtime: getRuntime(),
  version: getVersion(),
  results: results.map(r => ({ name: r.name, avg: r.avg }))
}, null, 2));

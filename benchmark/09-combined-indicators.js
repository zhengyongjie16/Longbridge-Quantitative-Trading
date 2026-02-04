/**
 * 测试9: 组合指标计算性能测试（使用 technicalindicators 库）
 * 模拟实际交易场景：一次计算多个指标
 */
import { getRuntime, getVersion, measure, printResult, printHeader } from './utils.js';

let RSI, MACD, EMA, Stochastic, MFI;
try {
  const ti = await import('technicalindicators');
  RSI = ti.RSI;
  MACD = ti.MACD;
  EMA = ti.EMA;
  Stochastic = ti.Stochastic;
  MFI = ti.MFI;
} catch (e) {
  console.log('无法导入 technicalindicators，请先运行 npm install');
  process.exit(1);
}

printHeader(`组合指标计算性能测试 - ${getRuntime()} ${getVersion()}`);

const results = [];

// 生成模拟K线数据
function generateCandles(count) {
  const candles = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const change = (Math.random() - 0.5) * 2;
    price = Math.max(1, price + change);
    const high = price + Math.random() * 2;
    const low = Math.max(0.1, price - Math.random() * 2);
    candles.push({
      open: price,
      high: high,
      low: low,
      close: price + (Math.random() - 0.5),
      volume: Math.floor(Math.random() * 1000000)
    });
  }
  return candles;
}

const candles500 = generateCandles(500);
const candles2000 = generateCandles(2000);

const closes500 = candles500.map(c => c.close);
const highs500 = candles500.map(c => c.high);
const lows500 = candles500.map(c => c.low);

const closes2000 = candles2000.map(c => c.close);
const highs2000 = candles2000.map(c => c.high);
const lows2000 = candles2000.map(c => c.low);
const volumes500 = candles500.map(c => c.volume);
const volumes2000 = candles2000.map(c => c.volume);

console.log('\n模拟实际交易场景：同时计算多个技术指标');
console.log('指标组合: RSI6 + KDJ + MFI + MACD + EMA5\n');

// 组合计算函数
function calculateAllIndicators(closes, highs, lows, volumes) {
  // RSI6
  const rsi6 = RSI.calculate({ values: closes, period: 6 });

  // MACD
  const macd = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false
  });

  // EMA5
  const ema5 = EMA.calculate({ values: closes, period: 5 });

  // KDJ (Stochastic)
  const kdj = Stochastic.calculate({
    high: highs,
    low: lows,
    close: closes,
    period: 9,
    signalPeriod: 3
  });

  // MFI
  const mfi = MFI.calculate({
    high: highs,
    low: lows,
    close: closes,
    volume: volumes,
    period: 14
  });

  return { rsi6, macd, ema5, kdj, mfi };
}

// 测试1: 500条K线组合计算 x500次
results.push(measure('组合指标 (500条) x500', () => {
  for (let i = 0; i < 500; i++) {
    calculateAllIndicators(closes500, highs500, lows500, volumes500);
  }
}, 5));

// 测试2: 500条K线组合计算 x1000次
results.push(measure('组合指标 (500条) x1000', () => {
  for (let i = 0; i < 1000; i++) {
    calculateAllIndicators(closes500, highs500, lows500, volumes500);
  }
}, 3));

// 测试3: 2000条K线组合计算 x200次
results.push(measure('组合指标 (2000条) x200', () => {
  for (let i = 0; i < 200; i++) {
    calculateAllIndicators(closes2000, highs2000, lows2000, volumes2000);
  }
}, 5));

// 测试4: 2000条K线组合计算 x500次
results.push(measure('组合指标 (2000条) x500', () => {
  for (let i = 0; i < 500; i++) {
    calculateAllIndicators(closes2000, highs2000, lows2000, volumes2000);
  }
}, 3));

// 打印结果
console.log('\n测试结果:');
results.forEach(printResult);

console.log('\n--- JSON结果 ---');
console.log(JSON.stringify({
  runtime: getRuntime(),
  version: getVersion(),
  results: results.map(r => ({ name: r.name, avg: r.avg }))
}, null, 2));

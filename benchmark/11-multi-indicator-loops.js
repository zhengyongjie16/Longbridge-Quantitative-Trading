/**
 * 测试11: 多指标组合 + 多轮循环性能测试（technicalindicators）
 * 场景：一次同时计算多个指标，并在多轮循环中对多标的重复执行
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

printHeader(`多指标组合与多轮循环性能测试 - ${getRuntime()} ${getVersion()}`);

const results = [];
let checksumSink = 0;

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
      high,
      low,
      close: price + (Math.random() - 0.5),
      volume: Math.floor(Math.random() * 1000000)
    });
  }
  return candles;
}

function buildSeries(symbolCount, candleCount) {
  const series = [];
  for (let i = 0; i < symbolCount; i++) {
    const candles = generateCandles(candleCount);
    series.push({
      closes: candles.map(c => c.close),
      highs: candles.map(c => c.high),
      lows: candles.map(c => c.low),
      volumes: candles.map(c => c.volume)
    });
  }
  return series;
}

function calculateIndicatorPack({ closes, highs, lows, volumes }) {
  const rsi6 = RSI.calculate({ values: closes, period: 6 });
  const rsi14 = RSI.calculate({ values: closes, period: 14 });
  const macd = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false
  });
  const ema5 = EMA.calculate({ values: closes, period: 5 });
  const ema20 = EMA.calculate({ values: closes, period: 20 });
  const kdj = Stochastic.calculate({
    high: highs,
    low: lows,
    close: closes,
    period: 9,
    signalPeriod: 3
  });
  const mfi = MFI.calculate({
    high: highs,
    low: lows,
    close: closes,
    volume: volumes,
    period: 14
  });

  return (
    rsi6.length +
    rsi14.length +
    macd.length +
    ema5.length +
    ema20.length +
    kdj.length +
    mfi.length
  );
}

function runLoops(seriesList, cycles) {
  let checksum = 0;
  for (let round = 0; round < cycles; round++) {
    for (const series of seriesList) {
      checksum += calculateIndicatorPack(series);
    }
  }
  return checksum;
}

console.log('\n场景: 多标的 x 多轮循环，同时计算多指标');
console.log('指标组合: RSI6/RSI14 + MACD + EMA5/EMA20 + KDJ + MFI\n');

const series10_500 = buildSeries(10, 500);
const series30_500 = buildSeries(30, 500);
const series10_2000 = buildSeries(10, 2000);
const series30_2000 = buildSeries(30, 2000);

results.push(measure('10标的 500条 x50轮', () => {
  checksumSink ^= runLoops(series10_500, 50);
}, 5));

results.push(measure('30标的 500条 x50轮', () => {
  checksumSink ^= runLoops(series30_500, 50);
}, 3));

results.push(measure('10标的 2000条 x20轮', () => {
  checksumSink ^= runLoops(series10_2000, 20);
}, 5));

results.push(measure('30标的 2000条 x20轮', () => {
  checksumSink ^= runLoops(series30_2000, 20);
}, 3));

if (checksumSink === Number.MIN_SAFE_INTEGER) {
  console.log('checksum:', checksumSink);
}

console.log('\n测试结果:');
results.forEach(printResult);

console.log('\n--- JSON结果 ---');
console.log(JSON.stringify({
  runtime: getRuntime(),
  version: getVersion(),
  results: results.map(r => ({ name: r.name, avg: r.avg }))
}, null, 2));

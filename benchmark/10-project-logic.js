/**
 * 测试10: 项目实际业务逻辑性能测试
 * 模拟项目中的高频操作：
 * 1. 指标快照克隆 (cloneIndicatorSnapshot)
 * 2. 信号配置解析 (parseSignalConfig)
 * 3. 信号条件评估 (evaluateSignalConfig)
 * 4. 环形缓冲区操作 (Ring Buffer)
 * 5. 对象池操作 (Object Pool)
 * 6. 主循环模拟 (Main Loop Simulation)
 */

import { getRuntime, getVersion, measure, measureAsync, printResult, printHeader } from './utils.js';

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

printHeader(`项目业务逻辑性能测试 - ${getRuntime()} ${getVersion()}`);

const results = [];

// ============================================
// 1. 指标快照克隆 (来自 indicatorCache/utils.ts)
// ============================================

function cloneIndicatorSnapshot(snapshot) {
  const { kdj, macd, rsi, ema, psy } = snapshot;
  const cloned = {
    price: snapshot.price,
    changePercent: snapshot.changePercent,
    mfi: snapshot.mfi,
    kdj: kdj ? { k: kdj.k, d: kdj.d, j: kdj.j } : null,
    macd: macd ? { macd: macd.macd, dif: macd.dif, dea: macd.dea } : null,
    rsi: rsi ? { ...rsi } : null,
    ema: ema ? { ...ema } : null,
    psy: psy ? { ...psy } : null,
  };
  return cloned;
}

// 生成模拟指标快照
function generateIndicatorSnapshot() {
  return {
    price: 100 + Math.random() * 50,
    changePercent: (Math.random() - 0.5) * 10,
    mfi: Math.random() * 100,
    kdj: { k: Math.random() * 100, d: Math.random() * 100, j: Math.random() * 200 - 100 },
    macd: { macd: Math.random() * 2 - 1, dif: Math.random() * 2 - 1, dea: Math.random() * 2 - 1 },
    rsi: { rsi6: Math.random() * 100, rsi12: Math.random() * 100, rsi24: Math.random() * 100 },
    ema: { ema5: 100 + Math.random() * 10, ema10: 100 + Math.random() * 10, ema20: 100 + Math.random() * 10 },
    psy: { psy12: Math.random() * 100 },
  };
}

console.log('\n=== 1. 指标快照克隆测试 ===');

const testSnapshot = generateIndicatorSnapshot();

results.push(measure('快照克隆 x10000', () => {
  for (let i = 0; i < 10000; i++) {
    cloneIndicatorSnapshot(testSnapshot);
  }
}, 5));

results.push(measure('快照克隆 x100000', () => {
  for (let i = 0; i < 100000; i++) {
    cloneIndicatorSnapshot(testSnapshot);
  }
}, 5));

// ============================================
// 2. 信号配置解析 (来自 signalConfigParser.ts)
// ============================================

console.log('\n=== 2. 信号配置解析测试 ===');

// 简化版的信号配置解析器
function parseSignalConfig(configStr) {
  const orGroups = configStr.split('|').map(group => group.trim());

  return orGroups.map(group => {
    const thresholdMatch = group.match(/\/(\d+)$/);
    const threshold = thresholdMatch ? parseInt(thresholdMatch[1]) : null;
    const conditionStr = thresholdMatch ? group.slice(0, -thresholdMatch[0].length) : group;

    const cleanStr = conditionStr.replace(/^\(|\)$/g, '');
    const conditions = cleanStr.split(',').map(cond => {
      const match = cond.trim().match(/^([A-Za-z0-9:]+)\s*([<>=!]+)\s*(-?\d+\.?\d*)$/);
      if (match) {
        return {
          indicator: match[1],
          operator: match[2],
          value: parseFloat(match[3])
        };
      }
      return null;
    }).filter(Boolean);

    return { conditions, threshold };
  });
}

// 测试配置字符串（来自项目实际配置）
const testConfigs = [
  '(RSI:6<20,MFI<15,D<20,J<-1)/3|(J<-20)',
  '(RSI:6>80,MFI>85,D>80,J>101)/3|(J>120)',
  '(RSI:6<25,MFI<20)/2',
  'J<-15|D<15',
  '(RSI:6<30,MFI<25,D<25,J<0)/2|(J<-10)'
];

results.push(measure('配置解析 x10000', () => {
  for (let i = 0; i < 10000; i++) {
    for (const config of testConfigs) {
      parseSignalConfig(config);
    }
  }
}, 5));

results.push(measure('配置解析 x50000', () => {
  for (let i = 0; i < 50000; i++) {
    for (const config of testConfigs) {
      parseSignalConfig(config);
    }
  }
}, 3));

// ============================================
// 3. 信号条件评估 (来自 signalConfigParser.ts)
// ============================================

console.log('\n=== 3. 信号条件评估测试 ===');

function evaluateCondition(condition, indicatorState) {
  const { indicator, operator, value } = condition;
  let actualValue;

  // 解析指标名称
  if (indicator.includes(':')) {
    const [name, period] = indicator.split(':');
    const key = `${name.toLowerCase()}${period}`;
    actualValue = indicatorState[key];
  } else {
    const mapping = { 'K': 'k', 'D': 'd', 'J': 'j', 'MFI': 'mfi', 'MACD': 'macd', 'DIF': 'dif', 'DEA': 'dea' };
    actualValue = indicatorState[mapping[indicator] || indicator.toLowerCase()];
  }

  if (actualValue === undefined || actualValue === null) return false;

  switch (operator) {
    case '<': return actualValue < value;
    case '>': return actualValue > value;
    case '<=': return actualValue <= value;
    case '>=': return actualValue >= value;
    case '==': return actualValue === value;
    case '!=': return actualValue !== value;
    default: return false;
  }
}

function evaluateSignalConfig(parsedConfig, indicatorState) {
  for (const group of parsedConfig) {
    const { conditions, threshold } = group;
    let matchCount = 0;

    for (const condition of conditions) {
      if (evaluateCondition(condition, indicatorState)) {
        matchCount++;
      }
    }

    const requiredMatches = threshold || conditions.length;
    if (matchCount >= requiredMatches) {
      return true;
    }
  }
  return false;
}

// 预解析配置
const parsedConfigs = testConfigs.map(parseSignalConfig);

// 模拟指标状态
const indicatorState = {
  rsi6: 18,
  rsi12: 35,
  mfi: 12,
  k: 25,
  d: 18,
  j: -5,
  macd: 0.5,
  dif: 0.3,
  dea: 0.2,
  ema5: 105,
  ema10: 103,
  ema20: 100
};

results.push(measure('条件评估 x10000', () => {
  for (let i = 0; i < 10000; i++) {
    for (const config of parsedConfigs) {
      evaluateSignalConfig(config, indicatorState);
    }
  }
}, 5));

results.push(measure('条件评估 x100000', () => {
  for (let i = 0; i < 100000; i++) {
    for (const config of parsedConfigs) {
      evaluateSignalConfig(config, indicatorState);
    }
  }
}, 3));

// ============================================
// 4. 环形缓冲区操作 (来自 indicatorCache)
// ============================================

console.log('\n=== 4. 环形缓冲区操作测试 ===');

class RingBuffer {
  constructor(maxSize = 100) {
    this.buffer = new Array(maxSize);
    this.maxSize = maxSize;
    this.head = 0;
    this.size = 0;
  }

  push(item) {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.maxSize;
    if (this.size < this.maxSize) this.size++;
  }

  getEntries(count) {
    const result = [];
    const actualCount = Math.min(count, this.size);
    for (let i = 0; i < actualCount; i++) {
      const index = (this.head - 1 - i + this.maxSize) % this.maxSize;
      result.push(this.buffer[index]);
    }
    return result;
  }

  getLatest() {
    if (this.size === 0) return null;
    return this.buffer[(this.head - 1 + this.maxSize) % this.maxSize];
  }
}

const ringBuffer = new RingBuffer(100);

// 预填充数据
for (let i = 0; i < 100; i++) {
  ringBuffer.push(generateIndicatorSnapshot());
}

results.push(measure('环形缓冲区 push x10000', () => {
  for (let i = 0; i < 10000; i++) {
    ringBuffer.push(generateIndicatorSnapshot());
  }
}, 5));

results.push(measure('环形缓冲区 getEntries(10) x10000', () => {
  for (let i = 0; i < 10000; i++) {
    ringBuffer.getEntries(10);
  }
}, 5));

results.push(measure('环形缓冲区 getLatest x100000', () => {
  for (let i = 0; i < 100000; i++) {
    ringBuffer.getLatest();
  }
}, 5));

// ============================================
// 5. 对象池操作 (来自 utils/objectPool)
// ============================================

console.log('\n=== 5. 对象池操作测试 ===');

class ObjectPool {
  constructor(factory, reset, initialSize = 10) {
    this.factory = factory;
    this.reset = reset;
    this.pool = [];
    for (let i = 0; i < initialSize; i++) {
      this.pool.push(factory());
    }
  }

  acquire() {
    if (this.pool.length > 0) {
      return this.pool.pop();
    }
    return this.factory();
  }

  release(obj) {
    this.reset(obj);
    this.pool.push(obj);
  }
}

const signalPool = new ObjectPool(
  () => ({ type: null, symbol: null, price: 0, timestamp: 0, indicators: null }),
  (obj) => { obj.type = null; obj.symbol = null; obj.price = 0; obj.timestamp = 0; obj.indicators = null; },
  50
);

results.push(measure('对象池 acquire/release x10000', () => {
  for (let i = 0; i < 10000; i++) {
    const obj = signalPool.acquire();
    obj.type = 'BUY';
    obj.symbol = 'HSI';
    obj.price = 18000;
    obj.timestamp = Date.now();
    signalPool.release(obj);
  }
}, 5));

results.push(measure('对象池 acquire/release x100000', () => {
  for (let i = 0; i < 100000; i++) {
    const obj = signalPool.acquire();
    obj.type = 'BUY';
    obj.symbol = 'HSI';
    obj.price = 18000;
    obj.timestamp = Date.now();
    signalPool.release(obj);
  }
}, 3));

// ============================================
// 6. Map/Set 操作 (符号管理)
// ============================================

console.log('\n=== 6. Map/Set 操作测试 ===');

const symbolMap = new Map();
const symbolSet = new Set();
const symbols = ['HSI', 'HSTECH', '00700', '09988', '03690', '09618', '01810', '02318', '00941', '00005'];

// 预填充
for (const sym of symbols) {
  symbolMap.set(sym, { lastPrice: 100, lastUpdate: Date.now() });
  symbolSet.add(sym);
}

results.push(measure('Map get/set x100000', () => {
  for (let i = 0; i < 100000; i++) {
    const sym = symbols[i % symbols.length];
    const data = symbolMap.get(sym);
    data.lastPrice = 100 + Math.random();
    data.lastUpdate = Date.now();
    symbolMap.set(sym, data);
  }
}, 5));

results.push(measure('Set has/add x100000', () => {
  for (let i = 0; i < 100000; i++) {
    const sym = symbols[i % symbols.length];
    if (symbolSet.has(sym)) {
      symbolSet.delete(sym);
      symbolSet.add(sym);
    }
  }
}, 5));

// ============================================
// 7. 综合主循环模拟
// ============================================

console.log('\n=== 7. 综合主循环模拟测试 ===');

// 生成K线数据
function generateCandles(count) {
  const candles = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const change = (Math.random() - 0.5) * 2;
    price = Math.max(1, price + change);
    candles.push({
      open: price,
      high: price + Math.random() * 2,
      low: Math.max(0.1, price - Math.random() * 2),
      close: price + (Math.random() - 0.5),
      volume: Math.floor(Math.random() * 1000000)
    });
  }
  return candles;
}

const candles500 = generateCandles(500);
const closes500 = candles500.map(c => c.close);
const highs500 = candles500.map(c => c.high);
const lows500 = candles500.map(c => c.low);
const volumes500 = candles500.map(c => c.volume);

// 模拟单次主循环迭代
function simulateMainLoopIteration() {
  // 1. 计算技术指标
  const rsi6 = RSI.calculate({ values: closes500, period: 6 });
  const macd = MACD.calculate({
    values: closes500,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false
  });
  const ema5 = EMA.calculate({ values: closes500, period: 5 });
  const kdj = Stochastic.calculate({
    high: highs500,
    low: lows500,
    close: closes500,
    period: 9,
    signalPeriod: 3
  });
  const mfi = MFI.calculate({
    high: highs500,
    low: lows500,
    close: closes500,
    volume: volumes500,
    period: 14
  });

  // 2. 创建指标快照
  const snapshot = {
    price: closes500[closes500.length - 1],
    changePercent: 0.5,
    mfi: mfi[mfi.length - 1],
    kdj: kdj[kdj.length - 1],
    macd: macd[macd.length - 1],
    rsi: { rsi6: rsi6[rsi6.length - 1] },
    ema: { ema5: ema5[ema5.length - 1] },
    psy: null
  };

  // 3. 克隆快照并存入缓冲区
  const cloned = cloneIndicatorSnapshot(snapshot);
  ringBuffer.push(cloned);

  // 4. 评估信号配置
  const state = {
    rsi6: snapshot.rsi?.rsi6,
    mfi: snapshot.mfi,
    k: snapshot.kdj?.k,
    d: snapshot.kdj?.d,
    j: snapshot.kdj?.j,
    macd: snapshot.macd?.MACD,
    dif: snapshot.macd?.histogram,
    dea: snapshot.macd?.signal
  };

  let signalTriggered = false;
  for (const config of parsedConfigs) {
    if (evaluateSignalConfig(config, state)) {
      signalTriggered = true;
      break;
    }
  }

  // 5. 如果触发信号，从对象池获取信号对象
  if (signalTriggered) {
    const signal = signalPool.acquire();
    signal.type = 'BUY';
    signal.symbol = 'HSI';
    signal.price = snapshot.price;
    signal.timestamp = Date.now();
    signal.indicators = cloned;
    signalPool.release(signal);
  }

  return signalTriggered;
}

// 模拟10个标的的并发处理
async function simulateConcurrentProcessing() {
  const promises = [];
  for (let i = 0; i < 10; i++) {
    promises.push(Promise.resolve(simulateMainLoopIteration()));
  }
  await Promise.allSettled(promises);
}

results.push(measure('单次主循环迭代 x100', () => {
  for (let i = 0; i < 100; i++) {
    simulateMainLoopIteration();
  }
}, 5));

results.push(measure('单次主循环迭代 x500', () => {
  for (let i = 0; i < 500; i++) {
    simulateMainLoopIteration();
  }
}, 3));

// 异步并发测试
results.push(await measureAsync('并发处理10标的 x50', async () => {
  for (let i = 0; i < 50; i++) {
    await simulateConcurrentProcessing();
  }
}, 3));

results.push(await measureAsync('并发处理10标的 x100', async () => {
  for (let i = 0; i < 100; i++) {
    await simulateConcurrentProcessing();
  }
}, 3));

// ============================================
// 打印结果
// ============================================

console.log('\n' + '='.repeat(60));
console.log('测试结果汇总:');
console.log('='.repeat(60));
results.forEach(printResult);

console.log('\n--- JSON结果 ---');
console.log(JSON.stringify({
  runtime: getRuntime(),
  version: getVersion(),
  results: results.map(r => ({ name: r.name, avg: r.avg }))
}, null, 2));

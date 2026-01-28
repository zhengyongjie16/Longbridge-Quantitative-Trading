# 自动选标的多标的运行时模型 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在“自动获取交易标的”场景下，让单监控标的的单方向可同时存在多个交易标的，并在阶段一完成动态行情订阅；配置仍保持单值 `longSymbol/shortSymbol`，但在自动获取开启时**完全不参与交易标的选择**。

**Architecture:** 配置仍为单值；引入运行时 `TradeSymbolRegistry` 管理“监控标的 + 方向”的活跃/历史标的集合与活跃标的；提供 `TradeSymbolIndex` 进行符号→方向/监控标的映射；信号生成仅对“活跃标的”开新仓，对“已跟踪标的”执行平仓；行情客户端支持订阅/退订并由统一入口进行同步。

**Tech Stack:** TypeScript (ES2022), Node.js, LongPort OpenAPI, Node test runner.

---

## 需求再确认（与你的补充一致）

1. **多标的仅由自动选标触发**：配置中不需要支持多个标的。
2. **自动选标开启时**：`LONG_SYMBOL_N/SHORT_SYMBOL_N` 只作为“非自动模式”的配置来源，**在自动模式下完全不使用**。
3. **系统性与完整性**：每个阶段均为可运行版本，不允许兼容层、过渡分支或补丁逻辑。
4. **阶段一必须包含动态行情订阅**，确保新增标的能立即被行情覆盖。

---

## 核心设计（运行时多标的模型）

### 1) 运行时标的集合模型

对每个 `monitorSymbol + direction`，维护以下结构：

```ts
type DirectionSymbols = {
  readonly activeSymbol: string | null;        // 新开仓目标
  readonly trackedSymbols: ReadonlyArray<string>; // 所有需要监控/平仓的标的
};
```

规则：
- **activeSymbol**：自动选标最新结果（或非自动模式下的配置值）。
- **trackedSymbols**：包含 activeSymbol + 任何仍有订单/持仓/浮亏记录的历史标的。
- 仅 `activeSymbol` 会触发**买入**信号；`trackedSymbols` 参与**卖出/清仓/浮亏**流程。

### 2) TradeSymbolRegistry + TradeSymbolIndex

**TradeSymbolRegistry**：运行时唯一真实来源  
职责：记录 `monitorSymbol + direction` 的 `activeSymbol/trackedSymbols`，提供更新与查询。

**TradeSymbolIndex**：符号索引  
职责：`symbol -> { monitorSymbol, direction }`，用于订单监控/风险检查/刷新流程快速定位。

### 3) 信号与订单行为

- **买入信号**：仅对 `activeSymbol` 生成
- **卖出信号**：对 `trackedSymbols` 逐一评估（已有订单记录才允许生成）
- **风险检查/订单执行**：通过 `TradeSymbolIndex` 识别方向与监控标的

### 4) 缓存与清理策略

当 `activeSymbol` 更新时：
- 新 symbol 进入 `trackedSymbols`
- 旧 symbol 若无持仓/未成交订单/无订单记录，则移出 `trackedSymbols` 并清理：
  - `orderRecorder.clearBuyOrders(symbol, isLong)`
  - `unrealizedLossChecker.clearSymbol(symbol)`
  - `orderAPIManager.clearCache([symbol])`
  - `quoteClient.unsubscribeSymbols([symbol])` 并清理行情缓存

### 5) 动态行情订阅

- `MarketDataClient` 新增：
  - `subscribeSymbols(symbols: ReadonlyArray<string>): Promise<void>`
  - `unsubscribeSymbols(symbols: ReadonlyArray<string>): Promise<void>`
  - `getSubscribedSymbols(): ReadonlyArray<string>`
- `createMarketDataClient` 支持注入 `createQuoteContext`（测试可控）
- 订阅流程：`staticInfo()` → `quote()` → `subscribe()` → 更新缓存
- 退订流程：`unsubscribe()` → 清理 `quoteCache/prevCloseCache/staticInfoCache`
- **禁止**在 `getQuotes()` 中隐式订阅（订阅仅由 registry 同步触发）

---

## 实施计划（阶段一：完整可运行）

### Task 1: 新增运行时 TradeSymbolRegistry + TradeSymbolIndex

**Files:**
- Create: `src/services/tradeSymbols/registry.ts`
- Create: `src/services/tradeSymbols/index.ts`
- Modify: `src/types/index.ts`
- Create: `tests/tradeSymbolsRegistry.test.js`

**Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTradeSymbolRegistry } from '../dist/src/services/tradeSymbols/registry.js';

test('registry tracks active + tracked symbols', () => {
  const registry = createTradeSymbolRegistry();
  registry.setActiveSymbol('HSI.HK', 'LONG', 'L1');
  registry.trackSymbol('HSI.HK', 'LONG', 'L2');

  const state = registry.getDirectionState('HSI.HK', 'LONG');
  assert.equal(state.activeSymbol, 'L1');
  assert.deepEqual(state.trackedSymbols.sort(), ['L1', 'L2']);
});
```

**Step 2: Run test to verify it fails**

Run: `npm run build && node --test tests/tradeSymbolsRegistry.test.js`
Expected: FAIL (module not found)

**Step 3: Write minimal implementation**

```ts
export type DirectionSymbols = {
  readonly activeSymbol: string | null;
  readonly trackedSymbols: ReadonlyArray<string>;
};

export type TradeSymbolRegistry = {
  setActiveSymbol(monitorSymbol: string, direction: 'LONG' | 'SHORT', symbol: string | null): void;
  trackSymbol(monitorSymbol: string, direction: 'LONG' | 'SHORT', symbol: string): void;
  untrackSymbol(monitorSymbol: string, direction: 'LONG' | 'SHORT', symbol: string): void;
  getDirectionState(monitorSymbol: string, direction: 'LONG' | 'SHORT'): DirectionSymbols;
  getAllTrackedSymbols(): ReadonlyArray<string>;
};
```

**Step 4: Run test to verify it passes**

Run: `npm run build && node --test tests/tradeSymbolsRegistry.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add src/services/tradeSymbols/registry.ts src/services/tradeSymbols/index.ts src/types/index.ts tests/tradeSymbolsRegistry.test.js
git commit -m "feat: add runtime trade symbol registry"
```

---

### Task 2: 启动流程与主循环接入 registry

**Files:**
- Modify: `src/index.ts`
- Modify: `src/main/mainProgram/index.ts`
- Modify: `src/utils/helpers/quoteHelpers.ts`

**Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectAllQuoteSymbolsFromRegistry } from '../dist/src/utils/helpers/quoteHelpers.js';

test('collectAllQuoteSymbolsFromRegistry includes monitor + tracked symbols', () => {
  const registry = { getAllTrackedSymbols: () => ['L1', 'S1'], getAllMonitorSymbols: () => ['M1'] };
  const set = collectAllQuoteSymbolsFromRegistry(registry);
  assert.deepEqual(new Set(['M1','L1','S1']), set);
});
```

**Step 2: Run test to verify it fails**

Run: `npm run build && node --test tests/quoteSymbolsFromRegistry.test.js`
Expected: FAIL

**Step 3: Write minimal implementation**

```ts
export function collectAllQuoteSymbolsFromRegistry(registry: {
  getAllTrackedSymbols(): ReadonlyArray<string>;
  getAllMonitorSymbols(): ReadonlyArray<string>;
}): Set<string> {
  return new Set([...registry.getAllMonitorSymbols(), ...registry.getAllTrackedSymbols()]);
}
```

**Step 4: Run test to verify it passes**

Run: `npm run build && node --test tests/quoteSymbolsFromRegistry.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add src/index.ts src/main/mainProgram/index.ts src/utils/helpers/quoteHelpers.ts tests/quoteSymbolsFromRegistry.test.js
git commit -m "refactor: derive quote symbols from registry"
```

---

### Task 3: 信号生成与监控逻辑（active vs tracked）

**Files:**
- Modify: `src/core/strategy/index.ts`
- Modify: `src/main/processMonitor/index.ts`
- Modify: `src/core/signalProcessor/index.ts`
- Modify: `src/core/signalProcessor/utils.ts`
- Create: `tests/strategyActiveTracked.test.js`

**Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHangSengMultiIndicatorStrategy } from '../dist/src/core/strategy/index.js';

test('buy signals use active symbol only', () => {
  const strategy = createHangSengMultiIndicatorStrategy();
  const snapshot = { price: 10, changePercent: 0, ema: {}, rsi: { 6: 10 }, psy: {}, mfi: 10, kdj: { k: 1, d: 1, j: 1 }, macd: { macd: 1, dif: 1, dea: 1 } };
  const result = strategy.generateCloseSignals(snapshot, { buy: ['L1'], sell: ['L1','L2'] }, { buy: ['S1'], sell: ['S1','S2'] }, { getBuyOrdersForSymbol: () => [] });
  assert.ok(result.immediateSignals.every((s) => s.symbol !== 'L2'));
});
```

**Step 2: Run test to verify it fails**

Run: `npm run build && node --test tests/strategyActiveTracked.test.js`
Expected: FAIL (方法签名不匹配)

**Step 3: Write minimal implementation**

```ts
// generateCloseSignals 接收 { buy: string[], sell: string[] } 结构
```

**Step 4: Run test to verify it passes**

Run: `npm run build && node --test tests/strategyActiveTracked.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/strategy/index.ts src/main/processMonitor/index.ts src/core/signalProcessor/index.ts src/core/signalProcessor/utils.ts tests/strategyActiveTracked.test.js
git commit -m "refactor: use active vs tracked symbols"
```

---

### Task 4: 风险/订单/浮亏逻辑与 index 映射

**Files:**
- Modify: `src/core/risk/index.ts`
- Modify: `src/core/risk/warrantRiskChecker.ts`
- Modify: `src/core/unrealizedLossMonitor/index.ts`
- Modify: `src/core/trader/orderMonitor.ts`
- Modify: `src/core/trader/orderExecutor.ts`
- Modify: `src/main/mainProgram/index.ts`
- Create: `tests/symbolIndexMapping.test.js`

**Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTradeSymbolIndex } from '../dist/src/services/tradeSymbols/index.js';

test('symbol index resolves direction', () => {
  const index = createTradeSymbolIndex([{ monitorSymbol: 'M1', longSymbols: ['L1'], shortSymbols: ['S1'] }]);
  assert.equal(index.getInfo('S1')?.direction, 'SHORT');
});
```

**Step 2: Run test to verify it fails**

Run: `npm run build && node --test tests/symbolIndexMapping.test.js`
Expected: FAIL

**Step 3: Write minimal implementation**

```ts
// TradeSymbolIndex 从 registry 中构建 symbol -> direction/monitor 映射
```

**Step 4: Run test to verify it passes**

Run: `npm run build && node --test tests/symbolIndexMapping.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/risk/index.ts src/core/risk/warrantRiskChecker.ts src/core/unrealizedLossMonitor/index.ts src/core/trader/orderMonitor.ts src/core/trader/orderExecutor.ts src/main/mainProgram/index.ts tests/symbolIndexMapping.test.js
git commit -m "refactor: risk/order flow uses trade symbol index"
```

---

### Task 5: 行情动态订阅与订阅同步

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/services/quoteClient/types.ts`
- Modify: `src/services/quoteClient/index.ts`
- Modify: `src/index.ts`
- Modify: `src/main/mainProgram/index.ts`
- Create: `tests/quoteSubscription.test.js`

**Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarketDataClient } from '../dist/src/services/quoteClient/index.js';

test('marketDataClient supports subscribe/unsubscribe', async () => {
  const fakeCtx = {
    staticInfo: async (s) => s.map((symbol) => ({ symbol })),
    quote: async (s) => s.map((symbol) => ({ symbol, lastDone: 1, prevClose: 1, timestamp: new Date() })),
    subscribe: async () => {},
    unsubscribe: async () => {},
    setOnQuote: () => {},
    candlesticks: async () => [],
    tradingDays: async () => ({ tradingDays: [], halfTradingDays: [] }),
  };

  const client = await createMarketDataClient({
    config: {},
    symbols: [],
    createQuoteContext: async () => fakeCtx,
  });

  await client.subscribeSymbols(['A.HK']);
  assert.ok(client.getSubscribedSymbols().includes('A.HK'));
});
```

**Step 2: Run test to verify it fails**

Run: `npm run build && node --test tests/quoteSubscription.test.js`
Expected: FAIL

**Step 3: Write minimal implementation**

```ts
// MarketDataClient 接口新增方法
subscribeSymbols(symbols: ReadonlyArray<string>): Promise<void>;
unsubscribeSymbols(symbols: ReadonlyArray<string>): Promise<void>;
getSubscribedSymbols(): ReadonlyArray<string>;

// quoteClient/types.ts 允许注入 QuoteContext 工厂
createQuoteContext?: () => Promise<QuoteContext>;
```

**Step 4: Run test to verify it passes**

Run: `npm run build && node --test tests/quoteSubscription.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add src/types/index.ts src/services/quoteClient/types.ts src/services/quoteClient/index.ts src/index.ts src/main/mainProgram/index.ts tests/quoteSubscription.test.js
git commit -m "feat: add dynamic quote subscriptions"
```

---

### Task 6: 统一验证

**Step 1: Run lint**

Run: `npm run lint`
Expected: PASS

**Step 2: Run type-check**

Run: `npm run type-check`
Expected: PASS

**Step 3: Run build**

Run: `npm run build`
Expected: PASS

---

### 备注

- 运行时多标的仅由自动选标产生；配置保持单标的不变。
- 阶段一完成后系统即可在自动选标开启时稳定运行，无需兼容路径。

# 多标的数组化与动态行情订阅 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将交易标的从单值彻底升级为数组模型（方案B），并在同一阶段完成行情动态订阅，确保每个阶段均可正常运行。

**Architecture:** 以 `MonitorConfig.longSymbols/shortSymbols` 为唯一真实来源，构建 `TradeSymbolIndex` 提供符号→方向/监控标的的快速映射；更新所有上下文与风险/订单逻辑为数组处理；行情客户端支持动态订阅/退订并由统一入口管理。

**Tech Stack:** TypeScript (ES2022), Node.js, LongPort OpenAPI, Node test runner.

---

## 约束（非兼容 / 系统性）

- **彻底替换**：所有 `longSymbol/shortSymbol` 单值字段移除，改为 `longSymbols/shortSymbols` 数组；旧字段不再保留。
- **配置键更换**：使用 `LONG_SYMBOLS_N` / `SHORT_SYMBOLS_N`（逗号分隔），旧 `LONG_SYMBOL_N` / `SHORT_SYMBOL_N` 直接视为无效。
- **运行时一致性**：每个阶段提交后必须可编译、可运行；不引入兼容性分支或补丁式逻辑。
- **动态行情订阅**：阶段一必须包含订阅/退订能力，不允许“仅限已订阅标的”的过渡策略。

## 方案B详细分析（为何必须采用）

- **完整性**：数组化是结构性变化，任何“单值兼容层”都会让核心逻辑分叉，增加长期维护成本。
- **一致性**：统一为数组后，策略、风险、订单、缓存、行情订阅均可共享同一数据模型，无需兼容层。
- **可扩展**：未来自动选标的、标的替换、并行多标的都基于数组模型自然扩展。

## 核心设计（方案B）

### 1) 配置模型

- `MonitorConfig.longSymbols: ReadonlyArray<string>`
- `MonitorConfig.shortSymbols: ReadonlyArray<string>`
- 环境变量：
  - `LONG_SYMBOLS_1=55131.HK,55132.HK`
  - `SHORT_SYMBOLS_1=53456.HK,53457.HK`
- 解析规则：
  - 逗号分隔、去空白、去重、过滤空值
  - **必须有至少一个 long/short**；空数组视为配置错误
  - 若检测到旧键 `LONG_SYMBOL_` / `SHORT_SYMBOL_` → 直接报错

### 2) TradeSymbolIndex（新模块）

**职责：** 提供符号到监控标的/方向/索引的快速映射，避免在订单与风险流程中遍历数组。

接口建议：
```ts
export type TradeSymbolInfo = {
  readonly monitorSymbol: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly index: number;
  readonly symbol: string;
};

export type TradeSymbolIndex = {
  getInfo(symbol: string): TradeSymbolInfo | null;
  getSymbols(monitorSymbol: string, direction: 'LONG' | 'SHORT'): ReadonlyArray<string>;
  getAllTradingSymbols(): ReadonlyArray<string>;
  getAllMonitorSymbols(): ReadonlyArray<string>;
};
```

### 3) MonitorState / MonitorContext

- `MonitorState.longSymbols/shortSymbols` 改为数组
- `MonitorContext` 新增：
  - `longSymbolNames: string[]`
  - `shortSymbolNames: string[]`
  - `longQuotes: Array<Quote | null>`
  - `shortQuotes: Array<Quote | null>`
- `createMonitorContext()` 批量初始化名称、标准化代码、行情数组

### 4) 信号生成与处理

- `strategy.generateCloseSignals()` 遍历 `longSymbols/shortSymbols` 逐个生成信号
- `processMonitor()` 使用数组行情与数组持仓，逐一补全信号价格/名称
- `signalProcessor.applyRiskChecks()` 通过 `TradeSymbolIndex` 识别方向、监控标的

### 5) 风险与订单流程

- `warrantRiskChecker` 内部使用 `Map<symbol, WarrantInfo>`，初始化遍历数组
- `unrealizedLossMonitor` 遍历数组检查
- `orderMonitor` / `orderExecutor` 改为通过 `TradeSymbolIndex` 获取方向/监控标的
- `mainProgram` 刷新浮亏映射时使用 `TradeSymbolIndex` 解析 `isLongSymbol`

### 6) 动态行情订阅（阶段一必须完成）

- `MarketDataClient` 新增方法：
  - `subscribeSymbols(symbols: ReadonlyArray<string>): Promise<void>`
  - `unsubscribeSymbols(symbols: ReadonlyArray<string>): Promise<void>`
  - `getSubscribedSymbols(): ReadonlyArray<string>`
- `createMarketDataClient` 支持注入 `createQuoteContext`（测试与可控初始化）
- 订阅流程：`staticInfo()` → `quote()` → `subscribe()` → 更新缓存
- 退订流程：`unsubscribe()` → 清理行情缓存（quote/prevClose/staticInfo）
- **不允许** 在 `getQuotes()` 内做隐式订阅；订阅必须由显式入口触发（系统性设计）

---

## 实施计划（阶段一：完整替换）

### Task 1: 配置与类型数组化（含校验）

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/config/config.trading.ts`
- Modify: `src/config/config.validator.ts`
- Modify: `src/config/utils.ts`
- Create: `tests/configSymbols.test.js`
- Update: `README.md`（配置说明）

**Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMultiMonitorTradingConfig } from '../dist/src/config/config.trading.js';

test('parse LONG_SYMBOLS/SHORT_SYMBOLS as arrays', () => {
  const env = {
    MONITOR_SYMBOL_1: 'HSI.HK',
    LONG_SYMBOLS_1: 'A.HK,B.HK',
    SHORT_SYMBOLS_1: 'C.HK',
  };
  const config = createMultiMonitorTradingConfig({ env });
  assert.deepEqual(config.monitors[0].longSymbols, ['A.HK', 'B.HK']);
  assert.deepEqual(config.monitors[0].shortSymbols, ['C.HK']);
});

test('legacy LONG_SYMBOL/SHORT_SYMBOL are rejected', () => {
  const env = {
    MONITOR_SYMBOL_1: 'HSI.HK',
    LONG_SYMBOL_1: 'A.HK',
    SHORT_SYMBOL_1: 'C.HK',
  };
  assert.throws(() => createMultiMonitorTradingConfig({ env }));
});
```

**Step 2: Run test to verify it fails**

Run: `npm run build && node --test tests/configSymbols.test.js`
Expected: FAIL (字段不存在或解析失败)

**Step 3: Write minimal implementation**

```ts
// src/config/utils.ts
export const parseSymbolList = (env: NodeJS.ProcessEnv, key: string): string[] => {
  const raw = getStringConfig(env, key);
  if (!raw) return [];
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return Array.from(new Set(list));
};

// src/config/config.validator.ts
const assertNoLegacySymbolKeys = (env: NodeJS.ProcessEnv, index: number): void => {
  const suffix = `_${index}`;
  if (env[`LONG_SYMBOL${suffix}`] || env[`SHORT_SYMBOL${suffix}`]) {
    throw new Error(`已弃用 LONG_SYMBOL${suffix}/SHORT_SYMBOL${suffix}，请改用 LONG_SYMBOLS${suffix}/SHORT_SYMBOLS${suffix}`);
  }
};
```

**Step 4: Run test to verify it passes**

Run: `npm run build && node --test tests/configSymbols.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add src/types/index.ts src/config/config.trading.ts src/config/config.validator.ts src/config/utils.ts tests/configSymbols.test.js README.md
git commit -m "refactor: switch trading symbols to arrays"
```

---

### Task 2: 建立 TradeSymbolIndex + 更新上下文

**Files:**
- Create: `src/services/tradeSymbolIndex/index.ts`
- Modify: `src/services/monitorContext/index.ts`
- Modify: `src/utils/helpers/index.ts`
- Modify: `src/utils/helpers/quoteHelpers.ts`
- Modify: `src/types/index.ts`
- Create: `tests/tradeSymbolIndex.test.js`

**Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTradeSymbolIndex } from '../dist/src/services/tradeSymbolIndex/index.js';

test('tradeSymbolIndex resolves direction and monitor', () => {
  const index = createTradeSymbolIndex([
    { monitorSymbol: 'M1', longSymbols: ['L1', 'L2'], shortSymbols: ['S1'] },
  ]);
  assert.equal(index.getInfo('L2')?.direction, 'LONG');
  assert.equal(index.getInfo('S1')?.monitorSymbol, 'M1');
});
```

**Step 2: Run test to verify it fails**

Run: `npm run build && node --test tests/tradeSymbolIndex.test.js`
Expected: FAIL (module not found)

**Step 3: Write minimal implementation**

```ts
export const createTradeSymbolIndex = (monitors: ReadonlyArray<{
  readonly monitorSymbol: string;
  readonly longSymbols: ReadonlyArray<string>;
  readonly shortSymbols: ReadonlyArray<string>;
}>) => {
  const symbolMap = new Map<string, { monitorSymbol: string; direction: 'LONG' | 'SHORT'; index: number; symbol: string }>();
  const monitorMap = new Map<string, { longSymbols: string[]; shortSymbols: string[] }>();

  for (const monitor of monitors) {
    monitorMap.set(monitor.monitorSymbol, {
      longSymbols: [...monitor.longSymbols],
      shortSymbols: [...monitor.shortSymbols],
    });
    monitor.longSymbols.forEach((s, i) => symbolMap.set(s, { monitorSymbol: monitor.monitorSymbol, direction: 'LONG', index: i, symbol: s }));
    monitor.shortSymbols.forEach((s, i) => symbolMap.set(s, { monitorSymbol: monitor.monitorSymbol, direction: 'SHORT', index: i, symbol: s }));
  }

  return {
    getInfo: (symbol: string) => symbolMap.get(symbol) ?? null,
    getSymbols: (monitorSymbol: string, direction: 'LONG' | 'SHORT') =>
      direction === 'LONG' ? monitorMap.get(monitorSymbol)?.longSymbols ?? [] : monitorMap.get(monitorSymbol)?.shortSymbols ?? [],
    getAllTradingSymbols: () => Array.from(symbolMap.keys()),
    getAllMonitorSymbols: () => Array.from(monitorMap.keys()),
  };
};
```

**Step 4: Run test to verify it passes**

Run: `npm run build && node --test tests/tradeSymbolIndex.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add src/services/tradeSymbolIndex/index.ts src/services/monitorContext/index.ts src/utils/helpers/index.ts src/utils/helpers/quoteHelpers.ts src/types/index.ts tests/tradeSymbolIndex.test.js
git commit -m "feat: add trade symbol index and array-based context"
```

---

### Task 3: 信号生成与监控流程数组化

**Files:**
- Modify: `src/core/strategy/index.ts`
- Modify: `src/main/processMonitor/index.ts`
- Modify: `src/main/processMonitor/utils.ts`
- Modify: `src/core/signalProcessor/index.ts`
- Modify: `src/core/signalProcessor/utils.ts`
- Create: `tests/strategyMultiSymbols.test.js`

**Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHangSengMultiIndicatorStrategy } from '../dist/src/core/strategy/index.js';

test('generateCloseSignals handles multiple long symbols', () => {
  const strategy = createHangSengMultiIndicatorStrategy();
  const snapshot = { price: 10, changePercent: 0, ema: {}, rsi: { 6: 10 }, psy: {}, mfi: 10, kdj: { k: 1, d: 1, j: 1 }, macd: { macd: 1, dif: 1, dea: 1 } };
  const result = strategy.generateCloseSignals(snapshot, ['L1','L2'], ['S1'], { getBuyOrdersForSymbol: () => [] });
  assert.ok(Array.isArray(result.immediateSignals));
});
```

**Step 2: Run test to verify it fails**

Run: `npm run build && node --test tests/strategyMultiSymbols.test.js`
Expected: FAIL (方法签名不匹配)

**Step 3: Write minimal implementation**

```ts
// strategy.generateCloseSignals 签名改为 (longSymbols: string[], shortSymbols: string[])
for (const longSymbol of longSymbols) {
  // 生成买入/卖出做多信号
}
for (const shortSymbol of shortSymbols) {
  // 生成买入/卖出做空信号
}
```

**Step 4: Run test to verify it passes**

Run: `npm run build && node --test tests/strategyMultiSymbols.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/strategy/index.ts src/main/processMonitor/index.ts src/main/processMonitor/utils.ts src/core/signalProcessor/index.ts src/core/signalProcessor/utils.ts tests/strategyMultiSymbols.test.js
git commit -m "refactor: process signals with symbol arrays"
```

---

### Task 4: 风险/订单/浮亏逻辑数组化

**Files:**
- Modify: `src/core/risk/index.ts`
- Modify: `src/core/risk/warrantRiskChecker.ts`
- Modify: `src/core/unrealizedLossMonitor/index.ts`
- Modify: `src/core/trader/orderMonitor.ts`
- Modify: `src/core/trader/orderExecutor.ts`
- Modify: `src/main/mainProgram/index.ts`
- Create: `tests/warrantRiskMulti.test.js`

**Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWarrantRiskChecker } from '../dist/src/core/risk/warrantRiskChecker.js';

test('warrantRiskChecker stores per-symbol info', async () => {
  const checker = createWarrantRiskChecker();
  assert.ok(checker);
});
```

**Step 2: Run test to verify it fails**

Run: `npm run build && node --test tests/warrantRiskMulti.test.js`
Expected: FAIL (接口不支持数组)

**Step 3: Write minimal implementation**

```ts
// warrantRiskChecker 内部改为 Map<symbol, WarrantInfo>
const warrantInfoMap = new Map<string, WarrantInfo>();
const getWarrantInfo = (symbol: string) => warrantInfoMap.get(symbol) ?? null;
```

**Step 4: Run test to verify it passes**

Run: `npm run build && node --test tests/warrantRiskMulti.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/risk/index.ts src/core/risk/warrantRiskChecker.ts src/core/unrealizedLossMonitor/index.ts src/core/trader/orderMonitor.ts src/core/trader/orderExecutor.ts src/main/mainProgram/index.ts tests/warrantRiskMulti.test.js
git commit -m "refactor: risk and order flow for symbol arrays"
```

---

### Task 5: 行情动态订阅与订阅管理

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/services/quoteClient/types.ts`
- Modify: `src/services/quoteClient/index.ts`
- Modify: `src/index.ts`
- Modify: `src/main/mainProgram/index.ts`
- Create: `tests/quoteSubscription.test.js`

**Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarketDataClient } from '../dist/src/services/quoteClient/index.js';

test('marketDataClient supports dynamic subscribe/unsubscribe', async () => {
  const fakeCtx = {
    staticInfo: async (s) => s.map((symbol) => ({ symbol })),
    quote: async (s) => s.map((symbol) => ({ symbol, lastDone: 1, prevClose: 1, timestamp: new Date() })),
    subscribe: async () => {},
    unsubscribe: async () => {},
    setOnQuote: () => {},
    candlesticks: async () => [],
    tradingDays: async () => ({ tradingDays: [], halfTradingDays: [] }),
  };

  const client = await createMarketDataClient({
    config: {},
    symbols: [],
    createQuoteContext: async () => fakeCtx,
  });

  await client.subscribeSymbols(['A.HK']);
  assert.ok(client.getSubscribedSymbols().includes('A.HK'));
});
```

**Step 2: Run test to verify it fails**

Run: `npm run build && node --test tests/quoteSubscription.test.js`
Expected: FAIL (缺少动态订阅 API)

**Step 3: Write minimal implementation**

```ts
// MarketDataClient 接口新增方法
subscribeSymbols(symbols: ReadonlyArray<string>): Promise<void>;
unsubscribeSymbols(symbols: ReadonlyArray<string>): Promise<void>;
getSubscribedSymbols(): ReadonlyArray<string>;

// quoteClient/types.ts 允许注入 QuoteContext 工厂
createQuoteContext?: () => Promise<QuoteContext>;
```

**Implementation notes:**
- 在 `src/index.ts` 初始化完成 `TradeSymbolIndex` 后，调用 `marketDataClient.subscribeSymbols(index.getAllTradingSymbols())`，并确保包含所有 `monitorSymbol`。
- 在 `src/main/mainProgram/index.ts` 新增 `syncQuoteSubscriptions()`，对比 `getSubscribedSymbols()` 与最新 `TradeSymbolIndex`，执行订阅 diff。

**Step 4: Run test to verify it passes**

Run: `npm run build && node --test tests/quoteSubscription.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add src/types/index.ts src/services/quoteClient/types.ts src/services/quoteClient/index.ts src/index.ts src/main/mainProgram/index.ts tests/quoteSubscription.test.js
git commit -m "feat: add dynamic quote subscriptions"
```

---

### Task 6: 统一验证

**Step 1: Run lint**

Run: `npm run lint`
Expected: PASS

**Step 2: Run type-check**

Run: `npm run type-check`
Expected: PASS

**Step 3: Run build**

Run: `npm run build`
Expected: PASS

---

### 备注
- 所有 TS 修改必须遵守 `@typescript-project-specifications`。
- 阶段一包含数组化与动态订阅的完整替换，不保留旧路径。

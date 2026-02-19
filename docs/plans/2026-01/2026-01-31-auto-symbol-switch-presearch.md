# 自动换标预寻标实施方案

> **For Claude:** 必须使用 superpowers:executing-plans 按任务逐项执行。

**目标:** 换标触发时先预寻标；若候选标的与旧标的一致则不换并记录当日抑制；若不一致则进入换标流程，使用缓存候选完成占位（旧持仓卖完后才占用）。

**架构:** 将换标流程拆成两个阶段：候选判断与日内抑制、执行阶段（撤单 → 卖出 → 占位 → 可选回补）。候选写入 `SwitchState`，换标期间不二次寻标；日内抑制按"方向 + 标的 + 港股日期"记录，防止同标的循环触发。

**技术栈:** TypeScript, Node.js, LongPort OpenAPI

**关键规则:**
- 仅在触发换标时预寻标。
- 候选与旧标的一致时不清席位、不递增版本号，并记录当日抑制。
- 候选为空视为换标失败，席位置空，等待后续寻标。
- 候选不同则进入换标：无持仓直接占位，有持仓等待卖出完成后占位。

---

### 任务 1：新增回归脚本（同标的抑制）

**文件:**
- 新增: `tests/autoSymbolSwitchSameSymbol.js`

**步骤 1：编写失败用例**
```javascript
import assert from 'node:assert/strict';
import { createAutoSymbolManager } from '../dist/src/services/autoSymbolManager/index.js';
import { createSymbolRegistry } from '../dist/src/services/autoSymbolManager/utils.js';

function createMonitorConfig() {
  return {
    originalIndex: 1,
    monitorSymbol: 'HSI.HK',
    longSymbol: 'OLD',
    shortSymbol: 'OLDP',
    targetNotional: 1000,
    autoSearchConfig: {
      autoSearchEnabled: true,
      autoSearchMinPriceBull: 0.01,
      autoSearchMinPriceBear: 0.01,
      autoSearchMinTurnoverPerMinuteBull: 1,
      autoSearchMinTurnoverPerMinuteBear: 1,
      autoSearchExpiryMinMonths: 3,
      autoSearchOpenDelayMinutes: 0,
      switchDistanceRangeBull: { min: -10, max: -5 },
      switchDistanceRangeBear: { min: -10, max: -5 },
    },
  };
}

async function testSameSymbolSuppression() {
  const monitorConfig = createMonitorConfig();
  const symbolRegistry = createSymbolRegistry([monitorConfig]);

  symbolRegistry.updateSeatState('HSI.HK', 'LONG', {
    symbol: 'OLD',
    status: 'READY',
    lastSwitchAt: null,
    lastSearchAt: null,
  });

  let warrantListCalls = 0;
  const marketDataClient = {
    _getContext: async () => ({
      warrantList: async () => {
        warrantListCalls += 1;
        return [
          {
            symbol: 'OLD',
            status: 'Normal',
            turnover: 1000000,
            lastDone: 0.1,
            name: 'OLD NAME',
          },
        ];
      },
    }),
  };

  const riskChecker = {
    getWarrantDistanceInfo: () => ({ distanceToStrikePercent: -20 }),
  };

  const trader = {
    cancelOrder: async () => true,
    executeSignals: async () => {},
  };

  const orderRecorder = {
    getLatestSellRecord: () => null,
  };

  const autoSymbolManager = createAutoSymbolManager({
    monitorConfig,
    symbolRegistry,
    marketDataClient,
    trader,
    riskChecker,
    orderRecorder,
    now: () => new Date('2026-01-31T02:00:00Z'),
  });

  const beforeVersion = symbolRegistry.getSeatVersion('HSI.HK', 'LONG');

  await autoSymbolManager.maybeSwitchOnDistance({
    direction: 'LONG',
    monitorPrice: 20000,
    quotesMap: new Map(),
    positions: [],
    pendingOrders: [],
  });

  const seatState = symbolRegistry.getSeatState('HSI.HK', 'LONG');
  const afterVersion = symbolRegistry.getSeatVersion('HSI.HK', 'LONG');

  assert.equal(seatState.symbol, 'OLD');
  assert.equal(seatState.status, 'READY');
  assert.equal(afterVersion, beforeVersion, 'seat version should not change');
  assert.equal(warrantListCalls, 1, 'search should be called once');

  await autoSymbolManager.maybeSwitchOnDistance({
    direction: 'LONG',
    monitorPrice: 20000,
    quotesMap: new Map(),
    positions: [],
    pendingOrders: [],
  });

  assert.equal(warrantListCalls, 1, 'suppression should skip re-search');
}

async function testCachedCandidateAfterSell() {
  const monitorConfig = createMonitorConfig();
  const symbolRegistry = createSymbolRegistry([monitorConfig]);

  symbolRegistry.updateSeatState('HSI.HK', 'LONG', {
    symbol: 'OLD',
    status: 'READY',
    lastSwitchAt: null,
    lastSearchAt: null,
  });

  let warrantListCalls = 0;
  const marketDataClient = {
    _getContext: async () => ({
      warrantList: async () => {
        warrantListCalls += 1;
        return [
          {
            symbol: 'NEW',
            status: 'Normal',
            turnover: 1000000,
            lastDone: 0.1,
            name: 'NEW NAME',
          },
        ];
      },
    }),
  };

  const riskChecker = {
    getWarrantDistanceInfo: () => ({ distanceToStrikePercent: -20 }),
  };

  let executeSignalsCalls = 0;
  const trader = {
    cancelOrder: async () => true,
    executeSignals: async () => {
      executeSignalsCalls += 1;
    },
  };

  const orderRecorder = {
    getLatestSellRecord: () => null,
  };

  const autoSymbolManager = createAutoSymbolManager({
    monitorConfig,
    symbolRegistry,
    marketDataClient,
    trader,
    riskChecker,
    orderRecorder,
    now: () => new Date('2026-01-31T02:00:00Z'),
  });

  await autoSymbolManager.maybeSwitchOnDistance({
    direction: 'LONG',
    monitorPrice: 20000,
    quotesMap: new Map([[
      'OLD',
      { price: 0.1, lotSize: 100, name: 'OLD', symbol: 'OLD' },
    ]]),
    positions: [{ symbol: 'OLD', quantity: 1000, availableQuantity: 1000 }],
    pendingOrders: [],
  });

  assert.equal(executeSignalsCalls, 1, 'sell should be submitted');
  assert.equal(warrantListCalls, 1, 'candidate should be searched once');

  await autoSymbolManager.maybeSwitchOnDistance({
    direction: 'LONG',
    monitorPrice: 20000,
    quotesMap: new Map([[
      'NEW',
      { price: 0.1, lotSize: 100, name: 'NEW', symbol: 'NEW' },
    ]]),
    positions: [],
    pendingOrders: [],
  });

  const seatState = symbolRegistry.getSeatState('HSI.HK', 'LONG');
  assert.equal(seatState.symbol, 'NEW');
  assert.equal(warrantListCalls, 1, 'no re-search after sell');
}

await testSameSymbolSuppression();
await testCachedCandidateAfterSell();
console.log('ok');
```

**步骤 2：运行并确认失败**
运行: `npm run build && node tests/autoSymbolSwitchSameSymbol.js`  
预期: FAIL，包含 "seat version should not change"（当前逻辑同标的仍清席位并递增版本号）。

---

### 任务 2：实现预寻标、候选缓存与日内抑制

**文件:**
- 修改: `src/utils/helpers/tradingTime.ts`
- 修改: `src/services/autoSymbolManager/types.ts`
- 修改: `src/services/autoSymbolManager/index.ts`

**步骤 1：新增港股日期键**
```typescript
export function getHKDateKey(date: Date | null | undefined): string | null {
  if (!date) return null;
  const hkDate = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const year = hkDate.getUTCFullYear();
  const month = String(hkDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(hkDate.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
```

**步骤 2：扩展换标状态类型**
```typescript
export type SwitchState = {
  direction: 'LONG' | 'SHORT';
  oldSymbol: string;
  nextSymbol: string | null;
  startedAt: number;
  sellSubmitted: boolean;
  sellNotional: number | null;
  shouldRebuy: boolean;
  awaitingQuote: boolean;
};

export type SwitchSuppression = {
  readonly symbol: string;
  readonly dateKey: string;
};
```

**步骤 3：改造换标流程（使用缓存候选 + 日内抑制）**
```typescript
import {
  getTradingMinutesSinceOpen,
  getHKDateKey,
} from '../../utils/helpers/tradingTime.js';
import type { SwitchSuppression } from './types.js';

const switchSuppressions = new Map<'LONG' | 'SHORT', SwitchSuppression>();

function resolveSuppression(
  direction: 'LONG' | 'SHORT',
  seatSymbol: string,
): SwitchSuppression | null {
  const record = switchSuppressions.get(direction);
  if (!record) {
    return null;
  }
  const currentKey = getHKDateKey(now());
  if (!currentKey || record.dateKey !== currentKey || record.symbol !== seatSymbol) {
    switchSuppressions.delete(direction);
    return null;
  }
  return record;
}

function markSuppression(direction: 'LONG' | 'SHORT', seatSymbol: string): void {
  const dateKey = getHKDateKey(now());
  if (!dateKey) {
    return;
  }
  switchSuppressions.set(direction, { symbol: seatSymbol, dateKey });
}

async function findSwitchCandidate(direction: 'LONG' | 'SHORT'): Promise<string | null> {
  const { minPrice, minTurnoverPerMinute } = resolveAutoSearchThresholds(direction, autoSearchConfig);
  if (minPrice == null || minTurnoverPerMinute == null) {
    logger.error(`[自动换标] 缺少阈值配置，无法预寻标: ${monitorSymbol} ${direction}`);
    return null;
  }
  const ctx = await marketDataClient._getContext();
  const tradingMinutes = getTradingMinutesSinceOpen(now());
  const best = await findBestWarrant({
    ctx,
    monitorSymbol,
    isBull: direction === 'LONG',
    tradingMinutes,
    minPrice,
    minTurnoverPerMinute,
    expiryMinMonths: autoSearchConfig.autoSearchExpiryMinMonths,
    logger,
  });
  return best ? best.symbol : null;
}

async function processSwitchState(
  params: SwitchOnDistanceParams,
  state: SwitchState,
): Promise<void> {
  const { direction, quotesMap, positions, pendingOrders } = params;
  const { sellAction } = resolveDirectionSymbols(direction);
  const seatVersion = symbolRegistry.getSeatVersion(monitorSymbol, direction);

  const cancelTargets = pendingOrders.filter((order) =>
    isCancelableBuyOrder(order, state.oldSymbol),
  );

  if (cancelTargets.length > 0) {
    const results = await Promise.all(
      cancelTargets.map((order) => trader.cancelOrder(order.orderId)),
    );
    if (results.some((ok) => !ok)) {
      updateSeatState(direction, buildSeatState(null, 'EMPTY', null, null), false);
      switchStates.delete(direction);
      logger.error(`[自动换标] 撤销买入订单失败，换标中止: ${state.oldSymbol}`);
      return;
    }
  }

  const position = extractPosition(positions, state.oldSymbol);
  const totalQuantity = position?.quantity ?? 0;
  const availableQuantity = position?.availableQuantity ?? 0;

  if (Number.isFinite(totalQuantity) && totalQuantity > 0 && availableQuantity === 0) {
    return;
  }

  if (Number.isFinite(availableQuantity) && availableQuantity > 0) {
    if (!state.sellSubmitted) {
      const quote = quotesMap.get(state.oldSymbol) ?? null;
      if (!quote || quote.price == null || quote.lotSize == null) {
        return;
      }

      const signal = buildOrderSignal({
        action: sellAction,
        symbol: state.oldSymbol,
        quote,
        reason: '自动换标-移仓卖出',
        orderTypeOverride: 'ELO',
        quantity: availableQuantity,
        seatVersion,
      });

      await trader.executeSignals([signal]);
      signalObjectPool.release(signal);

      state.sellSubmitted = true;
      return;
    }
    return;
  }

  const latestSellRecord = orderRecorder.getLatestSellRecord(state.oldSymbol, direction === 'LONG');
  if (latestSellRecord && latestSellRecord.executedTime >= state.startedAt) {
    const actualNotional = latestSellRecord.executedPrice * latestSellRecord.executedQuantity;
    if (Number.isFinite(actualNotional) && actualNotional > 0) {
      state.sellNotional = actualNotional;
    }
  }

  if (!state.nextSymbol) {
    updateSeatState(direction, buildSeatState(null, 'EMPTY', null, null), false);
    switchStates.delete(direction);
    logger.warn(`[自动换标] 未找到新标的，席位置空: ${state.oldSymbol}`);
    return;
  }

  updateSeatState(
    direction,
    buildSeatState(state.nextSymbol, 'READY', now().getTime(), now().getTime()),
    false,
  );

  if (!state.shouldRebuy) {
    switchStates.delete(direction);
    return;
  }

  const quote = quotesMap.get(state.nextSymbol) ?? null;
  if (!quote || quote.price == null || quote.lotSize == null) {
    state.awaitingQuote = true;
    return;
  }

  const buyNotional = state.sellNotional ?? monitorConfig.targetNotional;
  const buyQuantity = calculateBuyQuantityByNotional(
    buyNotional,
    quote.price,
    quote.lotSize,
  );

  if (!buyQuantity) {
    switchStates.delete(direction);
    return;
  }

  const signal = buildOrderSignal({
    action: resolveDirectionSymbols(direction).buyAction,
    symbol: state.nextSymbol,
    quote,
    reason: '自动换标-移仓买入',
    orderTypeOverride: 'ELO',
    quantity: buyQuantity,
    seatVersion,
  });

  await trader.executeSignals([signal]);
  signalObjectPool.release(signal);
  switchStates.delete(direction);
}

async function maybeSwitchOnDistance({
  direction,
  monitorPrice,
  quotesMap,
  positions,
  pendingOrders,
}: SwitchOnDistanceParams): Promise<void> {
  if (!autoSearchConfig.autoSearchEnabled) {
    return;
  }

  const pendingSwitch = switchStates.get(direction);
  if (pendingSwitch) {
    const currentSeatState = symbolRegistry.getSeatState(monitorSymbol, direction);
    if (!currentSeatState.symbol || currentSeatState.status === 'EMPTY') {
      switchStates.delete(direction);
      logger.warn(
        `[自动换标] 席位已清空，终止待处理换标: ${monitorSymbol} ${direction}`,
      );
      return;
    }
    await processSwitchState(
      { direction, monitorPrice, quotesMap, positions, pendingOrders },
      pendingSwitch,
    );
    return;
  }

  const seatState = symbolRegistry.getSeatState(monitorSymbol, direction);
  if (!seatState.symbol || seatState.status !== 'READY') {
    return;
  }

  if (resolveSuppression(direction, seatState.symbol)) {
    logger.info(
      `[自动换标] 今日已抑制同标的换标: ${monitorSymbol} ${direction} ${seatState.symbol}`,
    );
    return;
  }

  const distanceInfo = riskChecker.getWarrantDistanceInfo(
    direction === 'LONG',
    seatState.symbol,
    monitorPrice,
  );

  const distancePercent = distanceInfo?.distanceToStrikePercent ?? null;
  const range = resolveAutoSearchThresholds(direction, autoSearchConfig).switchDistanceRange;

  if (distancePercent == null || !range) {
    return;
  }

  if (distancePercent <= range.min || distancePercent >= range.max) {
    const candidate = await findSwitchCandidate(direction);

    if (candidate && candidate === seatState.symbol) {
      markSuppression(direction, seatState.symbol);
      logger.warn(
        `[自动换标] 新标的与旧标的一样，今日不再换标: ${monitorSymbol} ${direction} ${candidate}`,
      );
      return;
    }

    clearSeat({ direction, reason: '距回收价阈值越界' });

    const position = extractPosition(positions, seatState.symbol);
    const hasPosition = (position?.quantity ?? 0) > 0;

    switchStates.set(direction, {
      direction,
      oldSymbol: seatState.symbol,
      nextSymbol: candidate ?? null,
      startedAt: now().getTime(),
      sellSubmitted: false,
      sellNotional: null,
      shouldRebuy: hasPosition,
      awaitingQuote: false,
    });

    await processSwitchState(
      { direction, monitorPrice, quotesMap, positions, pendingOrders },
      switchStates.get(direction)!,
    );
  }
}
```

**步骤 4：运行脚本验证通过**
运行: `npm run build && node tests/autoSymbolSwitchSameSymbol.js`  
预期: PASS 并输出 `ok`。

**步骤 5：运行类型检查**
运行: `npm run type-check`  
预期: 无 TypeScript 错误。

**步骤 6：运行 Lint**
运行: `npm run lint`  
预期: 无 ESLint 错误。

---

### 任务 3：更新换标流程文档

**文件:**
- 修改: `docs/flow/auto-symbol-switch-flow.md`

**步骤 1：在流程图中加入预寻标与同标的抑制**
```markdown
  G --|是|--> H["预寻标候选（findBestWarrant）"]
  H --> H1{"候选 == 旧标的?"}
  H1 --|是|--> H2["标记当日抑制；停止换标"]
  H1 --|否|--> I["clearSeat -> 创建 SwitchState（缓存候选）"]
```

---

### 任务 4：主循环跨日检测与日内抑制重置

**文件:**
- 修改: `src/types/index.ts`
- 修改: `src/index.ts`
- 修改: `src/main/mainProgram/index.ts`
- 修改: `src/services/autoSymbolManager/types.ts`
- 修改: `src/services/autoSymbolManager/index.ts`
- 新增: `tests/autoSymbolSwitchResetSuppression.js`

**步骤 1：扩展 LastState（记录当前港股日期键）**
```typescript
export type LastState = {
  // ...
  /** 当前港股日期键（用于跨日检测） */
  currentDayKey: string | null;
};
```

**步骤 2：初始化 currentDayKey（启动时写入）**
```typescript
const lastState: LastState = {
  // ...
  currentDayKey: getHKDateKey(new Date()),
};
```

**步骤 3：主循环跨日检测（跨日后刷新交易日信息 + 清理抑制）**
> 放置位置：`currentTime` 生成后、`isTradingDayToday` 计算前，避免当次循环仍使用旧交易日信息。
> 若运行环境非港股时区，需保证交易日查询与 `getHKDateKey` 使用同一日期基准。
```typescript
const currentDayKey = getHKDateKey(currentTime);
if (currentDayKey && currentDayKey !== lastState.currentDayKey) {
  lastState.currentDayKey = currentDayKey;
  logger.info(`[跨日] 进入新日期: ${currentDayKey}`);

  if (runtimeGateMode === 'strict') {
    try {
      const tradingDayInfo = await marketDataClient.isTradingDay(currentTime);
      lastState.cachedTradingDayInfo = tradingDayInfo;
      logger.info(
        tradingDayInfo.isTradingDay
          ? `跨日后交易日信息：${tradingDayInfo.isHalfDay ? '半日交易日' : '交易日'}`
          : '跨日后交易日信息：非交易日',
      );
    } catch (err) {
      logger.warn('跨日后交易日信息获取失败，将仅按交易时段判断', formatError(err));
    }
  }

  // 让状态重新计算并触发必要日志
  lastState.canTrade = null;
  lastState.isHalfDay = null;
  lastState.openProtectionActive = null;

  for (const monitorContext of monitorContexts.values()) {
    monitorContext.autoSymbolManager.resetDailySwitchSuppression();
  }
}
```

**步骤 4：新增接口清理日内抑制**
```typescript
export type AutoSymbolManager = {
  // ...
  resetDailySwitchSuppression(): void;
};

function resetDailySwitchSuppression(): void {
  switchSuppressions.clear();
}
```

**步骤 5：新增回归脚本（抑制清理）**
```javascript
import assert from 'node:assert/strict';
import { createAutoSymbolManager } from '../dist/src/services/autoSymbolManager/index.js';
import { createSymbolRegistry } from '../dist/src/services/autoSymbolManager/utils.js';

async function testResetSuppression() {
  const monitorConfig = {
    originalIndex: 1,
    monitorSymbol: 'HSI.HK',
    longSymbol: 'OLD',
    shortSymbol: 'OLDP',
    targetNotional: 1000,
    autoSearchConfig: {
      autoSearchEnabled: true,
      autoSearchMinPriceBull: 0.01,
      autoSearchMinPriceBear: 0.01,
      autoSearchMinTurnoverPerMinuteBull: 1,
      autoSearchMinTurnoverPerMinuteBear: 1,
      autoSearchExpiryMinMonths: 3,
      autoSearchOpenDelayMinutes: 0,
      switchDistanceRangeBull: { min: -10, max: -5 },
      switchDistanceRangeBear: { min: -10, max: -5 },
    },
  };
  const symbolRegistry = createSymbolRegistry([monitorConfig]);
  symbolRegistry.updateSeatState('HSI.HK', 'LONG', {
    symbol: 'OLD',
    status: 'READY',
    lastSwitchAt: null,
    lastSearchAt: null,
  });

  let warrantListCalls = 0;
  const marketDataClient = {
    _getContext: async () => ({
      warrantList: async () => {
        warrantListCalls += 1;
        return [
          {
            symbol: 'OLD',
            status: 'Normal',
            turnover: 1000000,
            lastDone: 0.1,
            name: 'OLD NAME',
          },
        ];
      },
    }),
  };
  const riskChecker = { getWarrantDistanceInfo: () => ({ distanceToStrikePercent: -20 }) };
  const trader = { cancelOrder: async () => true, executeSignals: async () => {} };
  const orderRecorder = { getLatestSellRecord: () => null };

  const manager = createAutoSymbolManager({
    monitorConfig,
    symbolRegistry,
    marketDataClient,
    trader,
    riskChecker,
    orderRecorder,
    now: () => new Date('2026-01-31T02:00:00Z'),
  });

  await manager.maybeSwitchOnDistance({
    direction: 'LONG',
    monitorPrice: 20000,
    quotesMap: new Map(),
    positions: [],
    pendingOrders: [],
  });
  assert.equal(warrantListCalls, 1);

  manager.resetDailySwitchSuppression();

  await manager.maybeSwitchOnDistance({
    direction: 'LONG',
    monitorPrice: 20000,
    quotesMap: new Map(),
    positions: [],
    pendingOrders: [],
  });
  assert.equal(warrantListCalls, 2, 'reset 后允许重新寻标');
}

await testResetSuppression();
console.log('ok');
```

**步骤 6：运行脚本与检查**
运行: `npm run build && node tests/autoSymbolSwitchSameSymbol.js && node tests/autoSymbolSwitchResetSuppression.js`  
预期: PASS 并输出 `ok`。

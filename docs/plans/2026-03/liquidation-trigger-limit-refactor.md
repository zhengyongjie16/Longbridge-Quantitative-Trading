# 重构方案：保护性清仓触发次数限制

## 需求概述

当前行为：浮亏触发保护性清仓后**立即**进入买入冷却期，一次触发即冷却。

目标行为：新增配置项「止损触发次数上限」，允许在同一冷却周期内多次触发保护性清仓而不立即进入买入冷却，仅当触发次数达到或超过该上限时才进入买入冷却。

## 可行性与合理性分析

### 可行性

1. **数据流天然支持**：当前 `recordCooldown` 和 `getRemainingMs` 的调用链路清晰——eventFlow 成交回调写入冷却记录，riskCheckPipeline 查询冷却状态。在 tracker 内部增加计数器即可实现"N 次后才冷却"的语义，不需要改动调用链路的拓扑结构。
2. **计数器的生命周期管理可行**：计数器按 `monitorSymbol:direction` 维度管理，与现有冷却键一致；午夜清理和冷却过期时同步重置计数器。
3. **启动恢复可行**：当前 tradeLogHydrator 已从成交日志中筛选保护性清仓记录，扩展为按时序模拟触发-冷却周期即可恢复计数器状态。

### 合理性

1. **业务逻辑合理**：某些市况下单次浮亏触发可能是短暂波动造成，允许多次尝试后再进入冷却更灵活。
2. **向后兼容**：当触发次数上限配置为 1 时，行为与当前完全一致。
3. **风险可控**：每次保护性清仓仍正常执行（清空订单记录、刷新浮亏缓存），只是推迟了买入冷却的写入时机。浮亏监控本身不受影响。

## 当前链路分析

```
浮亏监控 (unrealizedLossMonitor)
    │  浮亏超阈值
    ▼
保护性清仓信号提交 (trader.executeSignals)
    │  订单成交
    ▼
eventFlow.handleOrderChangedWhenActive()
    │  isProtectiveLiquidation === true
    ▼
liquidationCooldownTracker.recordCooldown()   ← 【当前：每次成交都写入冷却记录】
    │
    ▼
riskCheckPipeline (买入检查)
    │  getRemainingMs() > 0 → 拒绝买入
    ▼
买入被冷却拦截
```

## 重构后链路

```
浮亏监控 (unrealizedLossMonitor)
    │  浮亏超阈值
    ▼
保护性清仓信号提交 (trader.executeSignals)
    │  订单成交
    ▼
eventFlow.handleOrderChangedWhenActive()
    │  isProtectiveLiquidation === true
    ▼
liquidationCooldownTracker.recordLiquidationTrigger()   ← 【改动：记录触发，内部判断是否写入冷却】
    │  内部逻辑：
    │  1. triggerCount[key] += 1
    │  2. if triggerCount[key] >= triggerLimit → 写入冷却记录
    │  3. if triggerCount[key] < triggerLimit → 不写入冷却（允许继续买入）
    ▼
riskCheckPipeline (买入检查)
    │  getRemainingMs() > 0 → 拒绝买入（仅当已写入冷却记录时）
    ▼
买入被冷却拦截（仅在达到触发上限后）
```

## 详细改动方案

### 1. 配置层

#### 1.1 类型定义 `src/types/config.ts`

在 `MonitorConfig` 中新增字段：

```typescript
export type MonitorConfig = {
  // ... 现有字段 ...

  /** 保护性清仓后买入冷却配置（未配置时为 null） */
  readonly liquidationCooldown: LiquidationCooldownConfig | null;

  /** 触发买入冷却所需的保护性清仓次数（默认 1，即单次触发即冷却） */
  readonly liquidationTriggerLimit: number;

  // ... 现有字段 ...
};
```

#### 1.2 配置解析 `src/config/config.trading.ts`

新增环境变量 `LIQUIDATION_TRIGGER_LIMIT_${index}` 的解析：

```typescript
const liquidationTriggerLimit = parseBoundedNumberConfig({
  env,
  envKey: `LIQUIDATION_TRIGGER_LIMIT${suffix}`,
  defaultValue: 1, // 默认 1 次，与当前行为一致
  min: 1,
  max: 10,
});
```

返回对象中添加 `liquidationTriggerLimit` 字段。

#### 1.3 配置校验 `src/config/config.validator.ts`

在配置展示区域添加日志输出：

```typescript
if (monitorConfig.liquidationCooldown) {
  logger.info(`止损触发冷却次数: ${monitorConfig.liquidationTriggerLimit}`);
}
```

新增校验规则：当 `liquidationCooldown` 存在时，`liquidationTriggerLimit` 必须为 1-10 的正整数。

### 2. 冷却追踪器层

#### 2.1 类型定义 `src/services/liquidationCooldown/types.ts`

**新增类型**：

```typescript
/**
 * 记录保护性清仓触发的参数。
 * 类型用途：包含标的代码、方向、成交时间与触发上限，由 recordLiquidationTrigger 消费。
 * 数据来源：由 eventFlow 在保护性清仓成交后传入。
 * 使用范围：仅 liquidationCooldown 模块使用。
 */
export type RecordLiquidationTriggerParams = {
  readonly symbol: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly executedTimeMs: number;
  readonly triggerLimit: number;
};

/**
 * 记录保护性清仓触发的返回结果。
 * 类型用途：告知调用方当前触发是否导致了买入冷却的激活。
 * 使用范围：仅 liquidationCooldown 模块使用。
 */
export type RecordLiquidationTriggerResult = {
  /** 当前累计触发次数（含本次） */
  readonly currentCount: number;
  /** 本次触发是否导致了买入冷却的激活 */
  readonly cooldownActivated: boolean;
};

/**
 * 恢复触发计数器的参数。
 * 类型用途：启动恢复时将从成交日志模拟计算得到的当前周期计数写入追踪器。
 * 使用范围：仅 liquidationCooldown 模块使用。
 */
export type RestoreTriggerCountParams = {
  readonly symbol: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly count: number;
};
```

**修改 `LiquidationCooldownTracker` 接口**：

```typescript
export interface LiquidationCooldownTracker {
  /**
   * 记录保护性清仓触发事件。
   * 内部累加触发计数器，当计数达到 triggerLimit 时写入冷却记录。
   */
  recordLiquidationTrigger: (
    params: RecordLiquidationTriggerParams,
  ) => RecordLiquidationTriggerResult;

  /** 直接写入冷却时间戳（仅供 tradeLogHydrator 启动恢复使用，运行时请用 recordLiquidationTrigger） */
  recordCooldown: (params: RecordCooldownParams) => void;

  /** 恢复触发计数器（启动恢复专用） */
  restoreTriggerCount: (params: RestoreTriggerCountParams) => void;

  getRemainingMs: (params: GetRemainingMsParams) => number;

  /** 跨日午夜按策略清理：仅清除指定 keys，minutes 模式条目不受影响 */
  clearMidnightEligible: (params: ClearMidnightEligibleParams) => void;

  /** 重置所有触发计数器（午夜清理调用） */
  resetAllTriggerCounts: () => void;
}
```

#### 2.2 核心实现 `src/services/liquidationCooldown/index.ts`

**新增内部状态**：

```typescript
// 现有
const cooldownMap = new Map<string, number>(); // key → executedTimeMs

// 新增
const triggerCountMap = new Map<string, number>(); // key → 当前周期触发次数
```

**新增 `recordLiquidationTrigger` 方法**：

```typescript
/**
 * 记录保护性清仓触发事件。
 * 累加指定标的方向的触发计数器；当计数达到 triggerLimit 时写入冷却时间戳。
 * triggerLimit <= 0 或 executedTimeMs 无效时不记录。
 */
function recordLiquidationTrigger({
  symbol,
  direction,
  executedTimeMs,
  triggerLimit,
}: RecordLiquidationTriggerParams): RecordLiquidationTriggerResult {
  if (!Number.isFinite(executedTimeMs) || executedTimeMs <= 0 || triggerLimit <= 0) {
    return { currentCount: 0, cooldownActivated: false };
  }

  const key = buildCooldownKey(symbol, direction);
  const prevCount = triggerCountMap.get(key) ?? 0;
  const newCount = prevCount + 1;
  triggerCountMap.set(key, newCount);

  if (newCount >= triggerLimit) {
    // 达到触发上限，写入冷却记录
    cooldownMap.set(key, executedTimeMs);
    return { currentCount: newCount, cooldownActivated: true };
  }

  return { currentCount: newCount, cooldownActivated: false };
}
```

**修改 `getRemainingMs` 方法**（冷却过期时同步重置计数器）：

```typescript
function getRemainingMs({ symbol, direction, cooldownConfig }: GetRemainingMsParams): number {
  const key = buildCooldownKey(symbol, direction);
  const executedTimeMs = cooldownMap.get(key);
  if (executedTimeMs === undefined || !Number.isFinite(executedTimeMs)) {
    return 0;
  }

  const cooldownEndMs = resolveCooldownEndMs(executedTimeMs, cooldownConfig);
  if (cooldownEndMs === null || !Number.isFinite(cooldownEndMs)) {
    cooldownMap.delete(key);
    triggerCountMap.delete(key); // 同步重置计数器
    return 0;
  }

  const remainingMs = cooldownEndMs - nowMs();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    cooldownMap.delete(key);
    triggerCountMap.delete(key); // 冷却过期，重置计数器，允许新一轮触发
    return 0;
  }
  return remainingMs;
}
```

**新增 `restoreTriggerCount` 方法**（启动恢复专用）：

```typescript
/** 恢复触发计数器，用于启动时从成交日志恢复状态 */
function restoreTriggerCount({ symbol, direction, count }: RestoreTriggerCountParams): void {
  if (count > 0) {
    triggerCountMap.set(buildCooldownKey(symbol, direction), count);
  }
}
```

**新增 `resetAllTriggerCounts` 方法**（午夜清理调用）：

```typescript
/** 重置所有触发计数器 */
function resetAllTriggerCounts(): void {
  triggerCountMap.clear();
}
```

**更新返回对象**：

```typescript
return {
  recordLiquidationTrigger,
  recordCooldown, // 保留：仅供 tradeLogHydrator 启动恢复使用
  restoreTriggerCount,
  getRemainingMs,
  clearMidnightEligible,
  resetAllTriggerCounts,
};
```

### 3. 调用方改动

#### 3.1 TrackedOrder 与 TrackOrderParams 类型扩展 `src/core/trader/types.ts`

**TrackedOrder** 新增字段：

```typescript
export type TrackedOrder = {
  // ... 现有字段 ...

  /** 触发买入冷却所需的保护性清仓次数（保护性清仓订单成交时使用） */
  readonly liquidationTriggerLimit: number;
};
```

**TrackOrderParams** 新增字段：

```typescript
export type TrackOrderParams = {
  // ... 现有字段 ...

  /** 触发买入冷却所需的保护性清仓次数（可选，默认 1） */
  readonly liquidationTriggerLimit?: number;
};
```

#### 3.2 orderOps `src/core/trader/orderMonitor/orderOps.ts`

`trackOrder` 方法中解构新增 `liquidationTriggerLimit`，并写入 TrackedOrder：

```typescript
function trackOrder(params: TrackOrderParams): void {
  const {
    // ... 现有解构 ...
    liquidationTriggerLimit,
  } = params;
  // ...
  const order: TrackedOrder = {
    // ... 现有字段 ...
    liquidationTriggerLimit: liquidationTriggerLimit ?? 1,
  };
  runtime.trackedOrders.set(orderId, order);
}
```

#### 3.3 submitFlow `src/core/trader/orderExecutor/submitFlow.ts`

在 `submitTargetOrder` 中 `orderMonitor.trackOrder` 调用处新增传参：

```typescript
orderMonitor.trackOrder({
  orderId,
  symbol,
  side,
  price: resolvedPrice ?? 0,
  quantity: submittedQuantityNum,
  isLongSymbol,
  monitorSymbol: monitorConfig?.monitorSymbol ?? null,
  isProtectiveLiquidation,
  orderType: orderTypeParam,
  liquidationTriggerLimit: monitorConfig?.liquidationTriggerLimit ?? 1, // 新增
});
```

#### 3.4 quoteFlow `src/core/trader/orderMonitor/quoteFlow.ts`

卖出订单超时转市价单时，新建 TrackedOrder 需复制 `liquidationTriggerLimit`：

```typescript
trackOrder({
  orderId: newOrderId,
  symbol: order.symbol,
  side: order.side,
  price: 0,
  quantity: remainingQuantity,
  isLongSymbol: order.isLongSymbol,
  monitorSymbol: order.monitorSymbol,
  isProtectiveLiquidation: order.isProtectiveLiquidation,
  orderType: OrderType.MO,
  liquidationTriggerLimit: order.liquidationTriggerLimit, // 新增：从原订单复制
});
```

#### 3.5 eventFlow `src/core/trader/orderMonitor/eventFlow.ts`

**当前代码**（第 99-110 行）：

```typescript
if (trackedOrder.isProtectiveLiquidation) {
  const direction = trackedOrder.isLongSymbol ? 'LONG' : 'SHORT';
  if (trackedOrder.monitorSymbol) {
    liquidationCooldownTracker.recordCooldown({
      symbol: trackedOrder.monitorSymbol,
      direction,
      executedTimeMs,
    });
  } else {
    logger.error(`[订单监控] 订单 ${orderId} 缺少监控标的代码，无法记录清仓冷却`);
  }
}
```

**改为**：

```typescript
if (trackedOrder.isProtectiveLiquidation) {
  const direction = trackedOrder.isLongSymbol ? 'LONG' : 'SHORT';
  if (trackedOrder.monitorSymbol) {
    const triggerLimit = trackedOrder.liquidationTriggerLimit;
    const result = liquidationCooldownTracker.recordLiquidationTrigger({
      symbol: trackedOrder.monitorSymbol,
      direction,
      executedTimeMs,
      triggerLimit,
    });
    if (result.cooldownActivated) {
      logger.warn(
        `[订单监控] 订单 ${orderId} 保护性清仓触发次数已达上限（${result.currentCount}/${triggerLimit}），进入买入冷却`,
      );
    } else {
      logger.info(
        `[订单监控] 订单 ${orderId} 保护性清仓触发 ${result.currentCount}/${triggerLimit}，未进入买入冷却`,
      );
    }
  } else {
    logger.error(`[订单监控] 订单 ${orderId} 缺少监控标的代码，无法记录清仓冷却`);
  }
}
```

#### 3.6 riskCheckPipeline `src/core/signalProcessor/riskCheckPipeline.ts`

**无需改动**。riskCheckPipeline 中的冷却检查仍调用 `getRemainingMs()`，该方法的语义不变——只有当冷却记录存在且未过期时才返回正值。在触发次数未达上限时，冷却记录不会被写入，`getRemainingMs()` 返回 0，买入信号自然通过。

### 4. 启动恢复

#### 4.1 `src/services/liquidationCooldown/utils.ts`

**删除 `resolveCooldownCandidatesBySeat`**：该函数仅被旧版 hydrate 逻辑使用，重构后不再有调用方，按项目规范删除死代码。

**新增函数** `collectLiquidationRecordsByMonitor`：

与已删除的 `resolveCooldownCandidatesBySeat` 的关键区别：

- 按 `TradeRecord.monitorSymbol`（而非 `record.symbol`）匹配，确保换标后旧交易标的的 PL 记录不会丢失。
- 方向从 `TradeRecord.action`（`SELLCALL` → LONG，`SELLPUT` → SHORT）推导，不依赖当前席位快照。
- 返回所有保护性清仓记录（而非仅最后一条），按 `monitorSymbol:direction` 分组并按时间升序排列。

```typescript
/**
 * 从成交记录中按监控标的和方向收集所有保护性清仓记录。
 * 1. 按 monitorSymbol 匹配（而非交易标的 symbol），确保换标后旧标的的 PL 记录不丢失
 * 2. 方向从 action 推导（SELLCALL→LONG，SELLPUT→SHORT），不依赖席位快照
 * 3. 返回所有记录（而非仅最后一条），供触发计数器周期模拟使用
 *
 * @param params.monitorSymbols 当前所有监控标的代码集合
 * @param params.tradeRecords 当日成交记录列表
 * @returns 按 monitorSymbol:direction 分组的保护性清仓记录（组内按时间升序）
 */
export function collectLiquidationRecordsByMonitor({
  monitorSymbols,
  tradeRecords,
}: {
  readonly monitorSymbols: ReadonlySet<string>;
  readonly tradeRecords: ReadonlyArray<TradeRecord>;
}): ReadonlyMap<string, ReadonlyArray<CooldownCandidate>> {
  if (monitorSymbols.size === 0 || tradeRecords.length === 0) {
    return new Map();
  }

  const grouped = new Map<string, CooldownCandidate[]>();

  for (const record of tradeRecords) {
    // 仅处理保护性清仓记录
    if (record.isProtectiveClearance !== true) {
      continue;
    }

    const monitorSymbol = record.monitorSymbol;
    const executedAtMs = record.executedAtMs;
    if (!monitorSymbol || typeof executedAtMs !== 'number' || !Number.isFinite(executedAtMs)) {
      continue;
    }

    // 仅处理当前监控标的
    if (!monitorSymbols.has(monitorSymbol)) {
      continue;
    }

    // 从 action 推导方向
    const direction = resolveDirectionFromAction(record.action);
    if (!direction) {
      continue;
    }

    const key = buildCooldownKey(monitorSymbol, direction);
    let list = grouped.get(key);
    if (!list) {
      list = [];
      grouped.set(key, list);
    }
    list.push({ monitorSymbol, direction, executedAtMs });
  }

  // 组内按时间升序排列（模拟周期需要时序）
  for (const list of grouped.values()) {
    list.sort((a, b) => a.executedAtMs - b.executedAtMs);
  }

  return grouped;
}

/**
 * 从信号 action 推导方向。
 * SELLCALL → 卖出做多标的 → LONG 方向；SELLPUT → 卖出做空标的 → SHORT 方向。
 * 非卖出 action 返回 null。
 *
 * @param action 信号 action 字符串
 * @returns 方向或 null
 */
function resolveDirectionFromAction(action: string | null): 'LONG' | 'SHORT' | null {
  if (action === 'SELLCALL') {
    return 'LONG';
  }
  if (action === 'SELLPUT') {
    return 'SHORT';
  }
  return null;
}
```

**新增函数** `simulateTriggerCycle`：

启动恢复的核心算法——按时序模拟触发-冷却周期，得出当前周期的正确计数和冷却状态。

**为什么不能简单计数**：运行时当冷却过期后计数器会重置为 0 开始新一轮。如果当日发生过"触发 N 次 → 冷却 → 冷却过期 → 再次触发"的循环，朴素的总数计数会错误地将已过期周期的触发次数也算入当前周期。

```
错误示例（triggerLimit=3，minutes=30）：
  10:00 PL1, 10:15 PL2, 10:30 PL3(冷却至11:00), 11:15 PL4, 11:30 PL5
  朴素计数=5 → 误判 count>=3 → 错误激活冷却
  正确结果：当前周期 count=2（PL4+PL5），不应激活冷却
```

```typescript
/**
 * 模拟触发-冷却周期，计算当前周期的正确计数和冷却状态。
 * 按时间顺序遍历 PL 记录，每达到 triggerLimit 时计算冷却结束时间；
 * 若后续记录在冷却过期之后，则重置计数器开始新周期。
 *
 * @param params.records 按时间升序排列的保护性清仓记录
 * @param params.triggerLimit 触发上限
 * @param params.cooldownConfig 冷却配置
 * @returns 当前周期的计数和冷却激活时间（null 表示未激活冷却）
 */
export function simulateTriggerCycle({
  records,
  triggerLimit,
  cooldownConfig,
}: {
  readonly records: ReadonlyArray<CooldownCandidate>;
  readonly triggerLimit: number;
  readonly cooldownConfig: LiquidationCooldownConfig | null;
}): {
  readonly currentCount: number;
  readonly cooldownExecutedTimeMs: number | null;
} {
  if (records.length === 0 || triggerLimit <= 0) {
    return { currentCount: 0, cooldownExecutedTimeMs: null };
  }

  let count = 0;
  let cooldownEndMs = 0; // 当前冷却结束时间（0 表示无冷却）
  let lastCooldownTimeMs: number | null = null; // 最后一次冷却激活的成交时间

  for (const record of records) {
    // 若当前记录在冷却过期之后，开始新周期
    if (cooldownEndMs > 0 && record.executedAtMs >= cooldownEndMs) {
      count = 0;
      cooldownEndMs = 0;
      lastCooldownTimeMs = null;
    }

    // 冷却期内的记录跳过（正常运行时冷却期内不可能有新 PL，但防御性处理）
    if (cooldownEndMs > 0 && record.executedAtMs < cooldownEndMs) {
      continue;
    }

    count += 1;

    if (count >= triggerLimit) {
      // 达到触发上限，计算冷却结束时间
      const endMs = resolveCooldownEndMs(record.executedAtMs, cooldownConfig);
      cooldownEndMs = endMs ?? 0;
      lastCooldownTimeMs = record.executedAtMs;
    }
  }

  return {
    currentCount: count,
    cooldownExecutedTimeMs: lastCooldownTimeMs,
  };
}
```

> 注意：`simulateTriggerCycle` 内部调用 `resolveCooldownEndMs`，该函数需从 `index.ts` 导出或提取到 `utils.ts`。考虑到 `resolveCooldownEndMs` 是纯函数（无闭包依赖），将其移至 `utils.ts` 作为模块级函数更合理。

#### 4.2 `src/services/liquidationCooldown/tradeLogHydrator.ts`

**移除 `seatSymbols` 参数**：新逻辑改为从 `tradingConfig.monitors` 获取监控标的集合，不再依赖席位快照。同步修改 `TradeLogHydrator` 接口签名和所有调用点，移除 `seatSymbols` 参数。

**扩展 hydrate 方法**，使用周期模拟替代朴素计数：

```typescript
function hydrate(): void {
  // ... 文件读取与解析逻辑不变 ...

  // 收集当前所有监控标的
  const monitorSymbols = new Set(tradingConfig.monitors.map((config) => config.monitorSymbol));

  // 按 monitorSymbol:direction 收集所有保护性清仓记录
  const allLiquidationRecords = collectLiquidationRecordsByMonitor({
    monitorSymbols,
    tradeRecords: records,
  });

  let restoredCount = 0;

  for (const [key, recordGroup] of allLiquidationRecords) {
    const { monitorSymbol, direction } = recordGroup[0];
    const monitorConfig = monitorConfigMap.get(monitorSymbol) ?? null;
    const triggerLimit = monitorConfig?.liquidationTriggerLimit ?? 1;
    const cooldownConfig = monitorConfig?.liquidationCooldown ?? null;

    if (!cooldownConfig) {
      continue;
    }

    // 模拟触发-冷却周期，得出当前周期的正确状态
    const cycleResult = simulateTriggerCycle({
      records: recordGroup,
      triggerLimit,
      cooldownConfig,
    });

    // 恢复当前周期的触发计数器
    if (cycleResult.currentCount > 0) {
      liquidationCooldownTracker.restoreTriggerCount({
        symbol: monitorSymbol,
        direction,
        count: cycleResult.currentCount,
      });
    }

    // 若当前周期激活了冷却，写入冷却时间戳并检查是否仍有效
    if (cycleResult.cooldownExecutedTimeMs !== null) {
      liquidationCooldownTracker.recordCooldown({
        symbol: monitorSymbol,
        direction,
        executedTimeMs: cycleResult.cooldownExecutedTimeMs,
      });

      const remainingMs = liquidationCooldownTracker.getRemainingMs({
        symbol: monitorSymbol,
        direction,
        cooldownConfig,
      });

      if (remainingMs > 0) {
        restoredCount += 1;
        logger.info(
          `[清仓冷却] 恢复 ${monitorSymbol}:${direction} 冷却，` +
            `当前周期触发 ${cycleResult.currentCount}/${triggerLimit}，` +
            `剩余 ${Math.ceil(remainingMs / 1000)} 秒`,
        );
      }
      // 若 remainingMs <= 0，getRemainingMs 已自动清除 cooldownMap 和 triggerCountMap
    }
  }

  logger.info(`[清仓冷却] 启动恢复完成，恢复冷却条数=${restoredCount}`);
}
```

**启动恢复时序验证示例**（`triggerLimit=3`，`minutes=30`）：

```
当日成交记录（按时间升序）：
  10:00 PL1, 10:15 PL2, 10:30 PL3, 11:15 PL4, 11:30 PL5

simulateTriggerCycle 执行过程：
  PL1: count=1, cooldownEndMs=0     → 未达上限
  PL2: count=2, cooldownEndMs=0     → 未达上限
  PL3: count=3, cooldownEndMs=11:00 → 达到上限，冷却至 11:00
  PL4: 11:15 >= 11:00 → 新周期，count=1, cooldownEndMs=0
  PL5: count=2, cooldownEndMs=0     → 未达上限

结果：currentCount=2, cooldownExecutedTimeMs=null
→ 恢复计数器为 2，不写入冷却 ✅
```

### 5. 午夜清理

#### 5.1 `src/main/lifecycle/cacheDomains/riskDomain.ts`

在 `runMidnightRiskClear` 中新增触发计数器重置：

```typescript
function runMidnightRiskClear(deps: RiskDomainDeps, ctx: LifecycleContext): void {
  const { signalProcessor, dailyLossTracker, monitorContexts, liquidationCooldownTracker } = deps;

  signalProcessor.resetRiskCheckCooldown();
  dailyLossTracker.resetAll(ctx.now);

  const keysToClear = collectMidnightEligibleCooldownKeys(monitorContexts);
  liquidationCooldownTracker.clearMidnightEligible({ keysToClear });

  // 新增：重置所有触发计数器（新交易日从零开始计数）
  liquidationCooldownTracker.resetAllTriggerCounts();

  const monitorCount = clearRiskCaches(monitorContexts);
  logger.info(`[Lifecycle][risk] 午夜清理完成: monitors=${monitorCount}`);
}
```

### 6. `resolveCooldownEndMs` 提取

当前 `resolveCooldownEndMs` 定义在 `index.ts` 内部（非导出），但 `simulateTriggerCycle`（在 `utils.ts` 中）也需要调用它。

**改动**：将 `resolveCooldownEndMs` 从 `index.ts` 移至 `utils.ts` 并导出，`index.ts` 改为从 `utils.ts` 导入。该函数是纯函数（无闭包依赖），移动不影响行为。

**import 变更**：

- `utils.ts`：新增 `import type { LiquidationCooldownConfig } from '../../types/config.js'`（供 `resolveCooldownEndMs` 和 `simulateTriggerCycle` 使用）；删除 `import type { SeatSymbolSnapshotEntry } from '../../types/seat.js'`（随 `resolveCooldownCandidatesBySeat` 删除）。
- `index.ts`：新增 `import { resolveCooldownEndMs } from './utils.js'`；删除原内部 `resolveCooldownEndMs` 函数定义。
- `tradeLogHydrator.ts`：删除 `import type { SeatSymbolSnapshotEntry } from '../../types/seat.js'`；将 `import { ... resolveCooldownCandidatesBySeat } from './utils.js'` 替换为 `import { collectLiquidationRecordsByMonitor, simulateTriggerCycle } from './utils.js'`。

### 7. 单元测试

#### 7.1 `tests/services/liquidationCooldown/business.test.ts`

新增测试用例：

| 场景                                               | 预期                              |
| -------------------------------------------------- | --------------------------------- |
| triggerLimit=1，触发 1 次                          | 立即进入冷却（向后兼容）          |
| triggerLimit=3，触发 1 次                          | 不进入冷却，getRemainingMs 返回 0 |
| triggerLimit=3，触发 2 次                          | 不进入冷却，getRemainingMs 返回 0 |
| triggerLimit=3，触发 3 次                          | 进入冷却，getRemainingMs 返回正值 |
| triggerLimit=3，触发 3 次后冷却过期                | 计数器重置为 0，可再次触发 3 次   |
| triggerLimit=3，触发 3 次冷却过期后再触发 2 次     | count=2，不进入冷却               |
| triggerLimit=3，触发 3 次冷却过期后再触发 3 次     | count=3，再次进入冷却             |
| 午夜清理后                                         | 计数器归零，冷却状态按模式清理    |
| restoreTriggerCount 恢复后 getRemainingMs 行为正确 | 无冷却记录时返回 0                |

#### 7.2 `tests/services/liquidationCooldown/utils.test.ts`（新增）

`simulateTriggerCycle` 测试用例：

| 场景                                        | 预期                                              |
| ------------------------------------------- | ------------------------------------------------- |
| 空记录                                      | count=0，无冷却                                   |
| 3 条记录，triggerLimit=3，minutes=30        | count=3，冷却激活（第 3 条时间）                  |
| 5 条记录，triggerLimit=3，第 3 条冷却已过期 | count=2（第 4、5 条），无冷却                     |
| 6 条记录，triggerLimit=3，第 3 条冷却已过期 | count=3（第 4、5、6 条），冷却激活（第 6 条时间） |
| 3 条记录，triggerLimit=3，冷却未过期        | count=3，冷却激活                                 |
| triggerLimit=1                              | 每条记录独立触发冷却，最终为最后一个未过期周期    |

`collectLiquidationRecordsByMonitor` 测试用例：

| 场景                                             | 预期                 |
| ------------------------------------------------ | -------------------- |
| 无保护性清仓记录                                 | 空 Map               |
| 混合保护性清仓和普通成交                         | 仅包含保护性清仓记录 |
| 换标后两个交易标的的 PL 都属于同一 monitorSymbol | 合并到同一组         |
| 多个 monitorSymbol 的记录                        | 分组正确             |
| 组内时间顺序                                     | 按 executedAtMs 升序 |

#### 7.3 `tests/services/liquidationCooldown/tradeLogHydrator.business.test.ts`

新增测试用例：

| 场景                                                             | 预期                                            |
| ---------------------------------------------------------------- | ----------------------------------------------- |
| 当日 2 条 PL 记录，triggerLimit=3                                | 恢复 count=2，不写入冷却                        |
| 当日 3 条 PL 记录，triggerLimit=3，冷却未过期                    | 恢复 count=3，冷却仍有效                        |
| 当日 3 条 PL 记录，triggerLimit=3，冷却已过期                    | count 和冷却均被清除                            |
| 当日 5 条 PL，triggerLimit=3，第 3 条冷却已过期                  | 恢复 count=2（新周期），不写入冷却              |
| 当日 6 条 PL，triggerLimit=3，第 3 条冷却已过期                  | 恢复 count=3（新周期），冷却有效（第 6 条时间） |
| 当日换标：BULL1 有 2 条 PL，BULL2 有 1 条 PL，同一 monitorSymbol | 合并 count=3                                    |

## 文件变更清单

| 文件                                                                   | 变更类型 | 说明                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.env.example`                                                         | 修改     | 在 `LIQUIDATION_COOLDOWN_MINUTES` 下方新增 `LIQUIDATION_TRIGGER_LIMIT` 环境变量示例与注释（格式见下方 .env.example 变更详情）                                                                                                                       |
| `src/types/config.ts`                                                  | 修改     | MonitorConfig 新增 `liquidationTriggerLimit` 字段                                                                                                                                                                                                   |
| `src/config/config.trading.ts`                                         | 修改     | 新增 `LIQUIDATION_TRIGGER_LIMIT` 环境变量解析                                                                                                                                                                                                       |
| `src/config/config.validator.ts`                                       | 修改     | 新增 `liquidationTriggerLimit` 校验与日志输出                                                                                                                                                                                                       |
| `src/services/liquidationCooldown/types.ts`                            | 修改     | 新增 `RecordLiquidationTriggerParams`、`RecordLiquidationTriggerResult`、`RestoreTriggerCountParams` 类型；扩展 `LiquidationCooldownTracker` 接口；`TradeLogHydrator` 接口移除 `seatSymbols` 参数；删除 `TradeLogHydratorDeps` 中不再需要的类型引用 |
| `src/services/liquidationCooldown/index.ts`                            | 修改     | 新增 `triggerCountMap`、`recordLiquidationTrigger`、`restoreTriggerCount`、`resetAllTriggerCounts`；`getRemainingMs` 冷却过期时同步重置计数器；`resolveCooldownEndMs` 移至 utils.ts                                                                 |
| `src/services/liquidationCooldown/utils.ts`                            | 修改     | 从 index.ts 接收 `resolveCooldownEndMs`；删除 `resolveCooldownCandidatesBySeat`；新增 `collectLiquidationRecordsByMonitor`、`resolveDirectionFromAction`、`simulateTriggerCycle`                                                                    |
| `src/services/liquidationCooldown/tradeLogHydrator.ts`                 | 修改     | 移除 `seatSymbols` 参数；使用 `collectLiquidationRecordsByMonitor` + `simulateTriggerCycle` 替代原有恢复逻辑                                                                                                                                        |
| `src/core/trader/types.ts`                                             | 修改     | `TrackedOrder` 新增 `liquidationTriggerLimit` 字段；`TrackOrderParams` 新增可选 `liquidationTriggerLimit` 字段                                                                                                                                      |
| `src/core/trader/orderMonitor/orderOps.ts`                             | 修改     | `trackOrder` 解构并写入 `liquidationTriggerLimit`                                                                                                                                                                                                   |
| `src/core/trader/orderExecutor/submitFlow.ts`                          | 修改     | `trackOrder` 调用新增 `liquidationTriggerLimit` 传参                                                                                                                                                                                                |
| `src/core/trader/orderMonitor/quoteFlow.ts`                            | 修改     | 超时转市价单时复制 `liquidationTriggerLimit`                                                                                                                                                                                                        |
| `src/core/trader/orderMonitor/eventFlow.ts`                            | 修改     | 将 `recordCooldown` 替换为 `recordLiquidationTrigger`                                                                                                                                                                                               |
| `src/main/lifecycle/cacheDomains/riskDomain.ts`                        | 修改     | 午夜清理新增 `resetAllTriggerCounts` 调用                                                                                                                                                                                                           |
| `tests/services/liquidationCooldown/business.test.ts`                  | 修改     | 新增触发次数限制相关测试用例                                                                                                                                                                                                                        |
| `tests/services/liquidationCooldown/utils.test.ts`                     | 新增     | `simulateTriggerCycle` 和 `collectLiquidationRecordsByMonitor` 测试                                                                                                                                                                                 |
| `tests/services/liquidationCooldown/tradeLogHydrator.business.test.ts` | 修改     | 移除 `seatSymbols` 传参；新增周期模拟恢复相关测试用例                                                                                                                                                                                               |
| `src/main/lifecycle/loadTradingDayRuntimeSnapshot.ts`                  | 修改     | hydrate 调用移除 `seatSymbols` 参数：`tradeLogHydrator.hydrate({ seatSymbols })` → `tradeLogHydrator.hydrate()`                                                                                                                                     |

### 8. `.env.example` 变更详情

在监控标的 1 的 `LIQUIDATION_COOLDOWN_MINUTES_1` 配置项下方新增：

```env
# 保护性清仓触发次数上限（可选，范围 1-10，默认 1）
# 设为 1 时每次清仓立即冷却（默认行为）；设为 N 时允许触发 N 次清仓后才进入冷却
# 仅在配置了 LIQUIDATION_COOLDOWN_MINUTES 时有意义
LIQUIDATION_TRIGGER_LIMIT_1=1
```

在监控标的 2 的注释区域对应位置新增：

```env
# # 保护性清仓触发次数上限（可选，范围 1-10，默认 1）
# LIQUIDATION_TRIGGER_LIMIT_2=1
```

## 业务流程示例

### 场景 A：triggerLimit = 3，冷却模式 = half-day

```
10:00 - 第 1 次浮亏触发保护性清仓
       → triggerCount = 1 (< 3)
       → 不进入冷却
       → 可立即再次买入

10:15 - 买入信号通过冷却检查（无冷却记录），正常买入

10:30 - 第 2 次浮亏触发保护性清仓
       → triggerCount = 2 (< 3)
       → 不进入冷却
       → 可立即再次买入

10:45 - 买入信号通过冷却检查，正常买入

11:00 - 第 3 次浮亏触发保护性清仓
       → triggerCount = 3 (>= 3)
       → 写入冷却记录（executedTimeMs = 11:00）
       → 冷却结束时间 = 当日 13:00（half-day，上午清仓）

11:10 - 买入信号检查冷却
       → getRemainingMs() 返回 ~6600000ms
       → 拒绝买入

13:01 - 买入信号检查冷却
       → getRemainingMs() 返回 0（冷却过期）
       → 同时 triggerCount 被重置为 0
       → 允许买入，新一轮触发重新计数
```

### 场景 B：triggerLimit = 3，冷却模式 = minutes(30)，跨冷却周期后重启

```
运行时：
10:00 - PL1 → count=1
10:15 - PL2 → count=2
10:30 - PL3 → count=3 → 冷却激活（至 11:00）
（冷却期间无法买入）
11:00 - 冷却过期 → count 重置为 0
11:15 - PL4 → count=1
11:30 - PL5 → count=2

11:35 - 进程重启

启动恢复：
  当日成交日志包含 PL1~PL5 共 5 条保护性清仓记录
  simulateTriggerCycle 模拟：
    PL1: count=1
    PL2: count=2
    PL3: count=3, cooldownEnd=11:00
    PL4: 11:15 >= 11:00 → 新周期, count=1
    PL5: count=2
  结果：currentCount=2, cooldownExecutedTimeMs=null
  → 恢复 count=2，不激活冷却
  → 系统恢复后可立即买入，行为与重启前一致 ✅
```

### 场景 C：当日换标，跨标的累计

```
运行时（HSI.HK:LONG 方向）：
09:30 - 席位标的 BULL1，PL1 → count=1
10:00 - PL2 → count=2
10:15 - 距离换标触发，BULL1 → BULL2
10:30 - 席位标的 BULL2，PL3 → count=3 → 冷却激活

启动恢复：
  成交日志中 PL1(BULL1) 和 PL2(BULL1) 的 monitorSymbol 均为 HSI.HK
  PL3(BULL2) 的 monitorSymbol 也为 HSI.HK
  collectLiquidationRecordsByMonitor 按 monitorSymbol 匹配 → 3 条全部归入 HSI.HK:LONG
  simulateTriggerCycle → count=3, 冷却激活 ✅
```

## 注意事项

1. **`recordCooldown` 保留**：原方法保留不删除，仅供 tradeLogHydrator 启动恢复使用（直接写入冷却时间戳，绕过计数器），eventFlow 运行时统一使用 `recordLiquidationTrigger`。不标记 `@deprecated`——它是启动恢复的必要接口。
2. **计数器重置时机与安全依赖**：冷却过期时（`getRemainingMs` 返回 0 时）和午夜清理时均重置计数器。两个时机互补——运行时依赖前者，跨日兜底依赖后者。这一设计的安全性依赖于一个关键链路保证：**新一轮买入必须经过 `riskCheckPipeline`，即 `getRemainingMs` 一定在买入前被调用**。因此冷却过期后，计数器会在下一次买入风控检查时被重置，先于任何新建仓和后续可能的 PL 触发。
3. **默认值兼容**：`liquidationTriggerLimit` 默认为 1，未配置时行为与当前完全一致。
4. **计数器与冷却独立**：`triggerCountMap` 和 `cooldownMap` 是两个独立的 Map，计数器仅控制何时写入冷却，不影响冷却本身的计算逻辑。
5. **`resolveCooldownEndMs` 迁移**：该纯函数从 `index.ts` 内部移至 `utils.ts` 导出，供 `index.ts` 和 `simulateTriggerCycle` 共同使用。迁移不改变任何行为。
6. **启动恢复使用周期模拟**：不能简单计数所有当日 PL 记录，必须模拟触发-冷却-过期-重置的完整周期，否则跨周期场景会产生错误的冷却激活。
7. **换标场景下的计数连续性**：运行时计数器按 `monitorSymbol:direction` 维度管理，换标不影响计数。启动恢复改用 `TradeRecord.monitorSymbol` 匹配（而非交易标的 symbol），确保换标前后的 PL 记录都能正确归组。
8. **配置变更跨重启的恢复准确性**：`simulateTriggerCycle` 使用**当前配置**的 `triggerLimit` 和 `cooldownConfig` 模拟历史周期。若用户在重启间修改了这些配置值（如 `minutes: 30 → 60` 或 `triggerLimit: 3 → 2`），模拟的周期边界可能与实际运行时不一致，导致恢复的计数器存在偏差。这是可接受的边界情况——恢复结果反映的是用户当前配置意图下的最合理状态，且偏差仅影响当前周期，下一个完整周期会自然修正。
9. **`resolveCooldownCandidatesBySeat` 删除**：该函数仅被旧版 hydrate 逻辑使用，重构后无调用方。按项目规范（禁止保留无用代码）将其连同对应测试一并删除。
10. **`seatSymbols` 参数移除**：新 hydrate 逻辑改为从 `tradingConfig.monitors` 获取监控标的集合，不再依赖席位快照参数。同步修改 `TradeLogHydrator` 接口签名和所有调用点。
11. **启动恢复时在途保护性清仓订单的 `triggerLimit` 降级行为**：进程重启时可能存在尚未成交的保护性清仓订单。启动恢复阶段为这些订单调用 `trackOrder` 时，`liquidationTriggerLimit` 参数未传入，将使用默认值 1。若该订单随后成交，`recordLiquidationTrigger` 以 `triggerLimit=1` 执行，会立即激活冷却。这属于**保守安全的降级行为**——保护性清仓订单通常使用市价单或 ELO，成交极快，在途跨重启的概率极低；即使发生，立即冷却是更安全的处理方式。且 tradeLogHydrator 的周期模拟在下次重启时会正确修正计数器状态。

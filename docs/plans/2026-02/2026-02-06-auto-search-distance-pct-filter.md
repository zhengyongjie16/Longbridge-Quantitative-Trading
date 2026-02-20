# 自动寻标筛选标准重构：从价格阈值迁移到距回收价百分比阈值

**日期**: 2026-02-06

**目标**: 将自动寻标的核心筛选标准从「当前价格 ≥ 最低价格阈值」改为「距回收价百分比满足阈值」，利用 warrantList API 返回的 `toCallPrice` 字段直接筛选，无需额外 API 调用。

**Tech Stack**: TypeScript (ES2022), Node.js, LongPort OpenAPI SDK, pino。

**规范约束**: 遵守 `typescript-project-specifications` skill 全部核心原则。

---

## 一、现状分析

### 1.1 当前筛选逻辑

自动寻标通过 `selectBestWarrant()` 函数对 `warrantList` API 返回的候选列表进行过滤和选优：

```
warrantList API 返回 → 状态过滤 → 价格过滤 → 成交额过滤 → 分均成交额过滤 → 选优（价格最低）
```

- **价格过滤**（`autoSymbolFinder/utils.ts:80-83`）：`warrant.lastDone >= minPrice`
- **选优**（`autoSymbolFinder/utils.ts:104-108`）：价格更低优先，相同价格则分均成交额更高优先
- **价格阈值来源**：环境变量 `AUTO_SEARCH_MIN_PRICE_BULL_N` / `AUTO_SEARCH_MIN_PRICE_BEAR_N`（HKD 绝对值）

### 1.2 当前数据流

```
.env → config.trading.ts 解析 → AutoSearchConfig.autoSearchMinPriceBull/Bear
  → thresholdResolver.ts 按方向提取 minPrice
    → autoSearch.ts / switchStateMachine.ts 传递 minPrice
      → autoSymbolFinder/index.ts 转发 minPrice
        → autoSymbolFinder/utils.ts selectBestWarrant() 使用 warrant.lastDone >= minPrice
```

启动流程有独立路径：

```
seat.ts 本地 resolveAutoSearchThresholds() → 提取 minPrice → findBestWarrant()
```

### 1.3 变更动机

- 价格阈值无法直接反映牛熊证的安全距离，相同价格的标的因行权价和换股比率不同，距回收价可能差异极大
- `warrantList` API 已返回 `toCallPrice`（距回收价百分比，`Decimal` 类型），无需额外计算或调用其他 API
- 按距回收价百分比筛选更贴近实际风控需求（与自动换标的越界判定逻辑保持语义一致）

---

## 二、目标筛选逻辑

### 2.1 筛选规则

| 方向 | 筛选条件                      | 说明                              |
| ---- | ----------------------------- | --------------------------------- |
| 牛证 | `toCallPrice > 阈值`（正数）  | 如阈值 = 0.02，则距回收价须 > 2%  |
| 熊证 | `toCallPrice < -阈值`（负数） | 如阈值 = 0.02，则距回收价须 < -2% |

- **阈值配置为正数**（如 `0.02` 表示 2%），代码内部对熊证取反
- **`toCallPrice`**：warrantList API 返回的小数形式（如 `0.025` = 2.5%），牛证为正值，熊证为负值

### 2.2 选优规则

替换原「价格更低优先」为「距回收价百分比绝对值更小优先」：

| 方向 | 选优方向                               | 含义                               |
| ---- | -------------------------------------- | ---------------------------------- |
| 牛证 | `toCallPrice` 值更小优先（仍 > 阈值）  | 更接近回收价 = 更高杠杆 = 更低溢价 |
| 熊证 | `toCallPrice` 值更大优先（仍 < -阈值） | 绝对值更小 = 更接近回收价          |
| 统一 | `\|toCallPrice\|` 更小优先             | 等价时取分均成交额更高者           |

**选优逻辑与原「价格更低优先」的一致性**：距回收价百分比绝对值越小 → 标的越靠近回收价 → 杠杆越高 → 价格通常越低。两种选优标准在实际候选集中高度一致。

### 2.3 不变的部分

以下逻辑保持不变：

- 交易状态过滤（`WarrantStatus.Normal`）
- 到期日过滤（`expiryMinMonths`）
- 成交额 > 0 检查
- 分均成交额过滤（`turnover / tradingMinutes >= minTurnoverPerMinute`）
- 总成交额过滤（`turnover >= minTurnoverPerMinute * tradingMinutes`）
- 缓存机制（`WarrantListCache`）
- API 调用方式（`requestWarrantList` 参数不变，`toCallPrice` 已在响应中）
- 自动换标的距回收价越界判定（运行时风控，独立于寻标筛选）

### 2.4 新筛选管线

```
warrantList API 返回 → 状态过滤 → 距回收价百分比过滤 → 成交额过滤 → 分均成交额过滤 → 选优（|距回收价|最小）
```

---

## 三、涉及文件清单

共 13 个文件，按依赖层级排列：

| #   | 层级     | 文件路径                                               | 修改类型            |
| --- | -------- | ------------------------------------------------------ | ------------------- |
| 1   | 类型定义 | `src/types/index.ts`                                   | 字段重命名          |
| 2   | 类型定义 | `src/services/autoSymbolFinder/types.ts`               | 4 个类型更新        |
| 3   | 类型定义 | `src/services/autoSymbolManager/types.ts`              | 多处字段重命名      |
| 4   | 核心逻辑 | `src/services/autoSymbolFinder/utils.ts`               | 筛选 + 选优逻辑重写 |
| 5   | 核心逻辑 | `src/services/autoSymbolFinder/index.ts`               | 参数传递更新        |
| 6   | 阈值解析 | `src/services/autoSymbolManager/thresholdResolver.ts`  | 字段映射更新        |
| 7   | 调用方   | `src/services/autoSymbolManager/autoSearch.ts`         | 参数传递更新        |
| 8   | 调用方   | `src/services/autoSymbolManager/switchStateMachine.ts` | 参数传递更新        |
| 9   | 启动流程 | `src/main/startup/seat.ts`                             | 阈值解析 + 参数传递 |
| 10  | 配置解析 | `src/config/config.trading.ts`                         | 环境变量重命名      |
| 11  | 配置校验 | `src/config/config.validator.ts`                       | 校验字段重命名      |
| 12  | 环境变量 | `.env.example`                                         | 变量名 + 注释更新   |
| 13  | 项目文档 | `README.md`                                            | 配置表 + 说明更新   |

**附带更新**（非代码）：

- `.claude/skills/core-program-business-logic/SKILL.md`：筛选原则描述

**无需修改**：

- `utils/getWarrants.js`：独立工具脚本，已使用 `toCallPrice` 筛选，逻辑正确
- 历史计划文档（`docs/plans/2026-01-29-*.md` 等）：为历史记录，不追溯修改
- 测试文件：经搜索无测试文件引用 `selectBestWarrant`/`findBestWarrant`/`autoSearchMinPrice`

---

## 四、逐文件修改方案

### 4.1 `src/types/index.ts` — AutoSearchConfig 类型

**位置**: 第 370-389 行

**变更**: 重命名 `autoSearchMinPriceBull` / `autoSearchMinPriceBear` 为 `autoSearchMinDistancePctBull` / `autoSearchMinDistancePctBear`，更新注释。

```diff
  export type AutoSearchConfig = {
    readonly autoSearchEnabled: boolean;
-   /** 牛证最低价格阈值 */
-   readonly autoSearchMinPriceBull: number | null;
-   /** 熊证最低价格阈值 */
-   readonly autoSearchMinPriceBear: number | null;
+   /** 牛证距回收价百分比阈值（正数，如 0.02 = 2%，筛选 toCallPrice > 此值） */
+   readonly autoSearchMinDistancePctBull: number | null;
+   /** 熊证距回收价百分比阈值（正数，如 0.02 = 2%，筛选 toCallPrice < -此值） */
+   readonly autoSearchMinDistancePctBear: number | null;
    readonly autoSearchMinTurnoverPerMinuteBull: number | null;
    readonly autoSearchMinTurnoverPerMinuteBear: number | null;
    readonly autoSearchExpiryMinMonths: number;
    readonly autoSearchOpenDelayMinutes: number;
    readonly switchDistanceRangeBull: NumberRange | null;
    readonly switchDistanceRangeBear: NumberRange | null;
  };
```

### 4.2 `src/services/autoSymbolFinder/types.ts` — 4 个类型更新

**4.2.1 WarrantListItem — 新增 `toCallPrice` 字段**

```diff
  export type WarrantListItem = {
    readonly symbol: string;
    readonly name?: string | null;
    readonly lastDone: DecimalLike | number | string | null | undefined;
    readonly turnover: DecimalLike | number | string | null | undefined;
+   readonly toCallPrice: DecimalLike | number | string | null | undefined;
    readonly warrantType: WarrantType | number | string | null | undefined;
    readonly status: WarrantStatus | number | string | null | undefined;
  };
```

**4.2.2 FindBestWarrantInput — `minPrice` → `minDistancePct`**

```diff
  export type FindBestWarrantInput = {
    readonly ctx: QuoteContext;
    readonly monitorSymbol: string;
    readonly isBull: boolean;
    readonly tradingMinutes: number;
-   readonly minPrice: number;
+   readonly minDistancePct: number;
    readonly minTurnoverPerMinute: number;
    readonly expiryMinMonths: number;
    readonly logger: Logger;
    readonly cacheConfig?: WarrantListCacheConfig;
  };
```

**4.2.3 SelectBestWarrantInput — `minPrice` → `minDistancePct` + 新增 `isBull`**

需要 `isBull` 来决定筛选方向（牛证取 `>` 、熊证取 `<`）。

```diff
  export type SelectBestWarrantInput = {
    readonly warrants: ReadonlyArray<WarrantListItem>;
    readonly tradingMinutes: number;
-   readonly minPrice: number;
+   readonly isBull: boolean;
+   readonly minDistancePct: number;
    readonly minTurnoverPerMinute: number;
  };
```

**4.2.4 WarrantCandidate — `price` → `distancePct`**

经验证，`WarrantCandidate.price` 仅在 `utils.ts` 内赋值，所有消费方（`autoSearch.ts`、`switchStateMachine.ts`、`seat.ts`）只使用 `best.symbol`，因此安全替换。

```diff
  export type WarrantCandidate = {
    readonly symbol: string;
    readonly name: string | null;
-   readonly price: number;
+   readonly distancePct: number;
    readonly turnover: number;
    readonly turnoverPerMinute: number;
  };
```

### 4.3 `src/services/autoSymbolManager/types.ts` — 多处字段重命名

涉及 4 处类型定义，统一将 `minPrice` 替换为 `minDistancePct`：

**4.3.1 BuildFindBestWarrantInputParams（约第 146 行）**

```diff
    readonly warrantListCacheConfig?: WarrantListCacheConfig;
-   readonly minPrice: number;
+   readonly minDistancePct: number;
    readonly minTurnoverPerMinute: number;
```

**4.3.2 ResolveAutoSearchThresholdInput 返回类型（约第 153-157 行）**

```diff
  export type ResolveAutoSearchThresholdInput = (
    params: Pick<ResolveAutoSearchThresholdInputParams, 'direction' | 'logPrefix'>,
  ) => Readonly<{
-   minPrice: number;
+   minDistancePct: number;
    minTurnoverPerMinute: number;
  }> | null;
```

**4.3.3 BuildFindBestWarrantInput 的 params Pick（约第 160-163 行）**

```diff
  export type BuildFindBestWarrantInput = (
    params: Pick<
      BuildFindBestWarrantInputParams,
-     'direction' | 'currentTime' | 'minPrice' | 'minTurnoverPerMinute'
+     'direction' | 'currentTime' | 'minDistancePct' | 'minTurnoverPerMinute'
    >,
  ) => Promise<FindBestWarrantInput>;
```

**4.3.4 SwitchStateMachineDeps.resolveAutoSearchThresholds 返回类型（约第 261 行）**

```diff
    readonly minPrice: number | null;
+   readonly minDistancePct: number | null;
    readonly minTurnoverPerMinute: number | null;
```

### 4.4 `src/services/autoSymbolFinder/utils.ts` — 核心筛选 + 选优逻辑重写

**整函数替换 `selectBestWarrant`**（第 56-128 行）：

移除 `lastDone` 价格过滤，改为 `toCallPrice` 距回收价百分比过滤；选优从「价格最低」改为「`|toCallPrice|` 最小」。

```typescript
export function selectBestWarrant({
  warrants,
  tradingMinutes,
  isBull,
  minDistancePct,
  minTurnoverPerMinute,
}: SelectBestWarrantInput): WarrantCandidate | null {
  const hasTradingMinutes = tradingMinutes > 0;
  const minTurnover = hasTradingMinutes ? minTurnoverPerMinute * tradingMinutes : 0;
  const shouldFilterTurnover = hasTradingMinutes || minTurnoverPerMinute > 0;
  // 牛证阈值为正（toCallPrice > threshold），熊证阈值取反为负（toCallPrice < -threshold）
  const distanceThreshold = isBull ? minDistancePct : -minDistancePct;

  let bestSymbol: string | null = null;
  let bestName: string | null = null;
  let bestDistancePct = 0;
  let bestAbsDistance = Infinity;
  let bestTurnover = 0;
  let bestTurnoverPerMinute = 0;

  for (const warrant of warrants) {
    if (!warrant?.symbol) {
      continue;
    }
    if (!isNormalStatus(warrant.status)) {
      continue;
    }

    // 距回收价百分比过滤：牛证 > 阈值，熊证 < -阈值
    const distancePct = decimalToNumber(warrant.toCallPrice);
    if (!Number.isFinite(distancePct)) {
      continue;
    }
    const distanceOk = isBull ? distancePct > distanceThreshold : distancePct < distanceThreshold;
    if (!distanceOk) {
      continue;
    }

    // 成交额过滤（逻辑不变）
    const turnover = decimalToNumber(warrant.turnover);
    if (!Number.isFinite(turnover) || turnover <= 0) {
      continue;
    }

    if (shouldFilterTurnover) {
      if (!hasTradingMinutes) {
        continue;
      }
      if (turnover < minTurnover) {
        continue;
      }
    }

    const turnoverPerMinute = hasTradingMinutes ? turnover / tradingMinutes : 0;
    if (turnoverPerMinute < minTurnoverPerMinute) {
      continue;
    }

    // 选优：|距回收价百分比| 更小优先（更接近阈值），相同则分均成交额更高优先
    const absDistance = Math.abs(distancePct);
    if (
      bestSymbol === null ||
      absDistance < bestAbsDistance ||
      (absDistance === bestAbsDistance && turnoverPerMinute > bestTurnoverPerMinute)
    ) {
      bestSymbol = warrant.symbol;
      bestName = warrant.name ?? null;
      bestDistancePct = distancePct;
      bestAbsDistance = absDistance;
      bestTurnover = turnover;
      bestTurnoverPerMinute = turnoverPerMinute;
    }
  }

  if (!bestSymbol) {
    return null;
  }

  return {
    symbol: bestSymbol,
    name: bestName,
    distancePct: bestDistancePct,
    turnover: bestTurnover,
    turnoverPerMinute: bestTurnoverPerMinute,
  };
}
```

**注意**：`import` 部分不变，`decimalToNumber` 已经可以处理 `DecimalLike | number | string | null | undefined`，与 `toCallPrice` 的类型兼容。

### 4.5 `src/services/autoSymbolFinder/index.ts` — 入口函数参数

**位置**: 第 118-152 行

```diff
  export async function findBestWarrant({
    ctx,
    monitorSymbol,
    isBull,
    tradingMinutes,
-   minPrice,
+   minDistancePct,
    minTurnoverPerMinute,
    expiryMinMonths,
    logger,
    cacheConfig,
  }: FindBestWarrantInput): Promise<WarrantCandidate | null> {
    // ... 获取 warrants 逻辑不变 ...

      const best = selectBestWarrant({
        warrants,
        tradingMinutes,
-       minPrice,
+       isBull,
+       minDistancePct,
        minTurnoverPerMinute,
      });

    // ... 其余不变
  }
```

### 4.6 `src/services/autoSymbolManager/thresholdResolver.ts` — 阈值映射

**4.6.1 `resolveAutoSearchThresholds` 返回类型与实现**（第 22-40 行）

```diff
  export function resolveAutoSearchThresholds(
    direction: 'LONG' | 'SHORT',
    config: AutoSearchConfig,
  ): {
-   readonly minPrice: number | null;
+   readonly minDistancePct: number | null;
    readonly minTurnoverPerMinute: number | null;
    readonly switchDistanceRange: ...;
  } {
    const isBull = direction === 'LONG';
    return {
-     minPrice: isBull ? config.autoSearchMinPriceBull : config.autoSearchMinPriceBear,
+     minDistancePct: isBull ? config.autoSearchMinDistancePctBull : config.autoSearchMinDistancePctBear,
      minTurnoverPerMinute: isBull
        ? config.autoSearchMinTurnoverPerMinuteBull
        : config.autoSearchMinTurnoverPerMinuteBear,
      switchDistanceRange: isBull ? config.switchDistanceRangeBull : config.switchDistanceRangeBear,
    };
  }
```

**4.6.2 `resolveAutoSearchThresholdInput` 返回类型与实现**（第 42-58 行）

```diff
  function resolveAutoSearchThresholdInput(
    params: ResolveAutoSearchThresholdInputParams,
  ): Readonly<{
-   minPrice: number;
+   minDistancePct: number;
    minTurnoverPerMinute: number;
  }> | null {
    const { direction, autoSearchConfig, monitorSymbol, logPrefix, logger } = params;
-   const { minPrice, minTurnoverPerMinute } = resolveAutoSearchThresholds(
+   const { minDistancePct, minTurnoverPerMinute } = resolveAutoSearchThresholds(
      direction,
      autoSearchConfig,
    );
-   if (minPrice == null || minTurnoverPerMinute == null) {
+   if (minDistancePct == null || minTurnoverPerMinute == null) {
      logger.error(`${logPrefix}: ${monitorSymbol} ${direction}`);
      return null;
    }
-   return { minPrice, minTurnoverPerMinute } as const;
+   return { minDistancePct, minTurnoverPerMinute } as const;
  }
```

**4.6.3 `buildFindBestWarrantInput` 参数**（第 60-89 行）

```diff
  async function buildFindBestWarrantInput(
    params: BuildFindBestWarrantInputParams,
  ): Promise<FindBestWarrantInput> {
    const {
      direction,
      monitorSymbol,
      autoSearchConfig,
      currentTime,
      marketDataClient,
      warrantListCacheConfig,
-     minPrice,
+     minDistancePct,
      minTurnoverPerMinute,
      getTradingMinutesSinceOpen,
      logger,
    } = params;
    const ctx = await marketDataClient._getContext();
    const tradingMinutes = getTradingMinutesSinceOpen(currentTime);
    const isBull = direction === 'LONG';
    return {
      ctx,
      monitorSymbol,
      isBull,
      tradingMinutes,
-     minPrice,
+     minDistancePct,
      minTurnoverPerMinute,
      expiryMinMonths: autoSearchConfig.autoSearchExpiryMinMonths,
      logger,
      ...(warrantListCacheConfig ? { cacheConfig: warrantListCacheConfig } : {}),
    };
  }
```

### 4.7 `src/services/autoSymbolManager/autoSearch.ts` — 参数传递

**位置**: 第 66-71 行

```diff
      const input = await buildFindBestWarrantInput({
        direction,
        currentTime,
-       minPrice: thresholds.minPrice,
+       minDistancePct: thresholds.minDistancePct,
        minTurnoverPerMinute: thresholds.minTurnoverPerMinute,
      });
```

### 4.8 `src/services/autoSymbolManager/switchStateMachine.ts` — 参数传递

**位置**: 约第 73-77 行

```diff
      const input = await buildFindBestWarrantInput({
        direction,
        currentTime: now(),
-       minPrice: thresholds.minPrice,
+       minDistancePct: thresholds.minDistancePct,
        minTurnoverPerMinute: thresholds.minTurnoverPerMinute,
      });
```

### 4.9 `src/main/startup/seat.ts` — 启动流程

**4.9.1 本地 `resolveAutoSearchThresholds` 函数**（第 17-36 行）

此函数为启动模块独立的阈值解析（不复用 `thresholdResolver.ts`），同步重命名。

```diff
  function resolveAutoSearchThresholds(
    direction: 'LONG' | 'SHORT',
    autoSearchConfig: {
-     readonly autoSearchMinPriceBull: number | null;
-     readonly autoSearchMinPriceBear: number | null;
+     readonly autoSearchMinDistancePctBull: number | null;
+     readonly autoSearchMinDistancePctBear: number | null;
      readonly autoSearchMinTurnoverPerMinuteBull: number | null;
      readonly autoSearchMinTurnoverPerMinuteBear: number | null;
    },
- ): { minPrice: number | null; minTurnoverPerMinute: number | null } {
+ ): { minDistancePct: number | null; minTurnoverPerMinute: number | null } {
    if (direction === 'LONG') {
      return {
-       minPrice: autoSearchConfig.autoSearchMinPriceBull,
+       minDistancePct: autoSearchConfig.autoSearchMinDistancePctBull,
        minTurnoverPerMinute: autoSearchConfig.autoSearchMinTurnoverPerMinuteBull,
      };
    }
    return {
-     minPrice: autoSearchConfig.autoSearchMinPriceBear,
+     minDistancePct: autoSearchConfig.autoSearchMinDistancePctBear,
      minTurnoverPerMinute: autoSearchConfig.autoSearchMinTurnoverPerMinuteBear,
    };
  }
```

**4.9.2 `searchSeatSymbol` 内联类型与调用**（第 197-243 行）

内联 `autoSearchConfig` 类型：

```diff
      readonly autoSearchConfig: {
        readonly autoSearchExpiryMinMonths: number;
-       readonly autoSearchMinPriceBull: number | null;
-       readonly autoSearchMinPriceBear: number | null;
+       readonly autoSearchMinDistancePctBull: number | null;
+       readonly autoSearchMinDistancePctBear: number | null;
        readonly autoSearchMinTurnoverPerMinuteBull: number | null;
        readonly autoSearchMinTurnoverPerMinuteBear: number | null;
      };
```

调用与传递：

```diff
-   const { minPrice, minTurnoverPerMinute } = resolveAutoSearchThresholds(
+   const { minDistancePct, minTurnoverPerMinute } = resolveAutoSearchThresholds(
      direction,
      autoSearchConfig,
    );
-   if (minPrice == null || minTurnoverPerMinute == null) {
+   if (minDistancePct == null || minTurnoverPerMinute == null) {
      logger.error(`[启动席位] 缺少自动寻标阈值配置: ${monitorSymbol} ${direction}`);
      return null;
    }
    // ...
    const best = await findBestWarrant({
      ctx,
      monitorSymbol,
      isBull: direction === 'LONG',
      tradingMinutes,
-     minPrice,
+     minDistancePct,
      minTurnoverPerMinute,
      expiryMinMonths: autoSearchConfig.autoSearchExpiryMinMonths,
      logger,
      // ...
    });
```

**4.9.3 `waitForSeatsReady` 中 `pendingSeats` 内联类型**（第 271-282 行）

```diff
        autoSearchConfig: {
          readonly autoSearchOpenDelayMinutes: number;
          readonly autoSearchExpiryMinMonths: number;
-         readonly autoSearchMinPriceBull: number | null;
-         readonly autoSearchMinPriceBear: number | null;
+         readonly autoSearchMinDistancePctBull: number | null;
+         readonly autoSearchMinDistancePctBear: number | null;
          readonly autoSearchMinTurnoverPerMinuteBull: number | null;
          readonly autoSearchMinTurnoverPerMinuteBear: number | null;
        };
```

### 4.10 `src/config/config.trading.ts` — 环境变量解析

**位置**: 第 101-103 行、第 181-183 行

```diff
- const autoSearchMinPriceBull = getNumberConfig(env, `AUTO_SEARCH_MIN_PRICE_BULL${suffix}`, 0);
- const autoSearchMinPriceBear = getNumberConfig(env, `AUTO_SEARCH_MIN_PRICE_BEAR${suffix}`, 0);
+ const autoSearchMinDistancePctBull = getNumberConfig(env, `AUTO_SEARCH_MIN_DISTANCE_PCT_BULL${suffix}`, 0);
+ const autoSearchMinDistancePctBear = getNumberConfig(env, `AUTO_SEARCH_MIN_DISTANCE_PCT_BEAR${suffix}`, 0);
```

返回对象：

```diff
    autoSearchConfig: {
      autoSearchEnabled,
-     autoSearchMinPriceBull,
-     autoSearchMinPriceBear,
+     autoSearchMinDistancePctBull,
+     autoSearchMinDistancePctBear,
      autoSearchMinTurnoverPerMinuteBull,
      // ...
    },
```

### 4.11 `src/config/config.validator.ts` — 校验字段

**位置**: 约第 259-278 行

```diff
    const requiredNumberFields = [
      {
-       value: autoSearchConfig.autoSearchMinPriceBull,
-       envKey: `AUTO_SEARCH_MIN_PRICE_BULL_${index}`,
+       value: autoSearchConfig.autoSearchMinDistancePctBull,
+       envKey: `AUTO_SEARCH_MIN_DISTANCE_PCT_BULL_${index}`,
      },
      {
-       value: autoSearchConfig.autoSearchMinPriceBear,
-       envKey: `AUTO_SEARCH_MIN_PRICE_BEAR_${index}`,
+       value: autoSearchConfig.autoSearchMinDistancePctBear,
+       envKey: `AUTO_SEARCH_MIN_DISTANCE_PCT_BEAR_${index}`,
      },
      // turnover 字段不变
    ];
```

### 4.12 `.env.example` — 环境变量模板

**监控标的 1**（第 99-101 行）：

```diff
- # 牛/熊最低价格阈值（HKD）
- AUTO_SEARCH_MIN_PRICE_BULL_1=0.048
- AUTO_SEARCH_MIN_PRICE_BEAR_1=0.048
+ # 牛/熊距回收价百分比阈值（小数形式，0.02 = 2%）
+ # 牛证：筛选 toCallPrice > 此值 的标的
+ # 熊证：筛选 toCallPrice < -此值 的标的
+ AUTO_SEARCH_MIN_DISTANCE_PCT_BULL_1=0.02
+ AUTO_SEARCH_MIN_DISTANCE_PCT_BEAR_1=0.02
```

**监控标的 2 注释示例**（第 191-193 行）：

```diff
- # # 牛/熊最低价格阈值（HKD）
- # AUTO_SEARCH_MIN_PRICE_BULL_2=0.08
- # AUTO_SEARCH_MIN_PRICE_BEAR_2=0.08
+ # # 牛/熊距回收价百分比阈值（小数形式，0.02 = 2%）
+ # AUTO_SEARCH_MIN_DISTANCE_PCT_BULL_2=0.02
+ # AUTO_SEARCH_MIN_DISTANCE_PCT_BEAR_2=0.02
```

### 4.13 `README.md` — 配置文档

**配置表**（约第 253-254 行）：

```diff
- | `AUTO_SEARCH_MIN_PRICE_BULL_N`      | `无`     | 牛证最低价格阈值                                     |
- | `AUTO_SEARCH_MIN_PRICE_BEAR_N`      | `无`     | 熊证最低价格阈值                                     |
+ | `AUTO_SEARCH_MIN_DISTANCE_PCT_BULL_N` | `无`   | 牛证距回收价百分比阈值（正数，如 0.02 = 2%）           |
+ | `AUTO_SEARCH_MIN_DISTANCE_PCT_BEAR_N` | `无`   | 熊证距回收价百分比阈值（正数，如 0.02 = 2%）           |
```

**筛选说明**（约第 270 行）：

```diff
- - **自动寻标筛选**：基于 LongPort `warrantList` 筛选牛/熊证：到期（`AUTO_SEARCH_EXPIRY_MIN_MONTHS_N`）、价格（`AUTO_SEARCH_MIN_PRICE_*`）、分均成交额（`AUTO_SEARCH_MIN_TURNOVER_PER_MINUTE_*`）；选优：**低价优先**，同价取 **分均成交额更高**。
+ - **自动寻标筛选**：基于 LongPort `warrantList` 筛选牛/熊证：到期（`AUTO_SEARCH_EXPIRY_MIN_MONTHS_N`）、距回收价百分比（`AUTO_SEARCH_MIN_DISTANCE_PCT_*`，牛证 > 阈值、熊证 < -阈值）、分均成交额（`AUTO_SEARCH_MIN_TURNOVER_PER_MINUTE_*`）；选优：**距回收价绝对值更小优先**，相同取 **分均成交额更高**。
```

---

## 五、附带更新：业务逻辑 Skill

**文件**: `.claude/skills/core-program-business-logic/SKILL.md`

**第 312-314 行**（自动寻标筛选原则）：

```diff
  - 过滤：交易状态正常、牛/熊方向匹配、到期月份满足下限、成交额大于 0
- - 阈值：价格达到最低门槛，且分均成交额达到最低门槛
- - 选优：价格更低优先；价格相同则分均成交额更高优先；仅取最优 1 个
+ - 阈值：距回收价百分比满足门槛（牛证 > 阈值，熊证 < -阈值），且分均成交额达到最低门槛
+ - 选优：距回收价百分比绝对值更小优先（更接近阈值）；相同则分均成交额更高优先；仅取最优 1 个
```

**第 432-433 行**（配置说明）：

```diff
- - 最低价格阈值（牛/熊分别配置）：低于门槛的候选不会被选中
+ - 距回收价百分比阈值（牛/熊分别配置）：不满足门槛的候选不会被选中
```

---

## 六、用户迁移

### 6.1 `.env.local` 手动迁移

用户需将 `.env.local` 中的环境变量从价格阈值改为百分比阈值：

```diff
- AUTO_SEARCH_MIN_PRICE_BULL_1=0.055
- AUTO_SEARCH_MIN_PRICE_BEAR_1=0.055
+ AUTO_SEARCH_MIN_DISTANCE_PCT_BULL_1=0.02
+ AUTO_SEARCH_MIN_DISTANCE_PCT_BEAR_1=0.02
```

**注意**：旧的价格阈值（如 `0.055` HKD）与新的百分比阈值（如 `0.02` = 2%）含义完全不同，不能直接沿用数值，需根据实际策略重新设定。

---

## 七、验证检查清单

| #   | 验证项                     | 方法                                |
| --- | -------------------------- | ----------------------------------- |
| 1   | TypeScript 编译通过        | `npx tsc --noEmit`                  |
| 2   | Lint 无新增错误            | ReadLints 检查所有修改文件          |
| 3   | 环境变量解析正确           | 启动程序确认配置读取无警告/错误     |
| 4   | 牛证筛选逻辑               | `toCallPrice > threshold` 时被选中  |
| 5   | 熊证筛选逻辑               | `toCallPrice < -threshold` 时被选中 |
| 6   | 选优逻辑                   | 距回收价绝对值最小者被选中          |
| 7   | 分均成交额过滤不变         | 低于阈值的候选仍被排除              |
| 8   | 启动寻标正常               | 启动时能通过新阈值找到合适标的      |
| 9   | 运行时自动换标后预寻标正常 | 换标状态机使用新阈值寻标            |

---

## 八、风险与注意事项

1. **API 字段可用性**：`toCallPrice` 已确认存在于 `WarrantInfo` 类型定义中（SDK `quote-types.md` 第 92 行），且 `utils/getWarrants.js` 已验证其可用性。

2. **`decimalToNumber` 兼容性**：该函数签名为 `(decimalLike: DecimalLike | number | string | null | undefined): number`，完全兼容 `toCallPrice` 的 `Decimal` 类型。

3. **无向后兼容**：此变更为环境变量重命名（`MIN_PRICE` → `MIN_DISTANCE_PCT`），旧环境变量名不会被读取，部署时必须同步更新 `.env.local`。

4. **`WarrantCandidate.price` 消费方安全性**：经搜索确认，所有 3 个消费方（`autoSearch.ts`、`switchStateMachine.ts`、`seat.ts`）仅使用 `best.symbol`，不访问 `best.price`，重命名为 `distancePct` 安全。

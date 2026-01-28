# 牛熊证距回收价清仓 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在主循环中实时监控牛/熊证距回收价百分比，触发阈值时以单独常量配置的 ELO 清仓，同时保证逻辑与类型系统一致、无兼容/补丁式实现。

**Architecture:** 由风险模块提供“距回收价清仓判定”，主循环在价格变化时调用判定并创建清仓信号。清仓信号携带显式的清仓标记与订单类型覆盖字段，订单执行器优先采用覆盖值，避免依赖 reason 文本判断。

**Tech Stack:** TypeScript (ES2022), Node.js, LongPort OpenAPI

---

## 需求再分析

- 交易标的可能为牛/熊证；若为牛/熊证才需要进行距回收价实时监控与清仓。
- 新增清仓阈值常量：牛证触发阈值 0.5%，熊证触发阈值 -0.5%。
- 新增清仓订单类型的独立常量配置，默认 ELO（增强限价单）。
- 触发清仓时必须执行清仓，并确保与现有风险/订单/订单记录逻辑一致。
- 禁止兼容式、补丁式实现；必须使用显式类型与统一流程进行系统性修改。

## 方案选项与选择

**推荐方案（A）**：风险模块新增“距回收价清仓判定”接口，主循环负责执行清仓信号，信号携带 `orderTypeOverride` 与 `isProtectiveLiquidation` 标记，订单执行器优先采用覆盖订单类型。  
优势：逻辑集中、类型明确、避免 reason 文本判断；与现有风险/订单模块解耦良好。  
代价：需要扩展类型与订单执行器逻辑，但改动清晰可控。

**备选方案（B）**：在 `processMonitor` 中直接根据 `getWarrantDistanceInfo()` 判断阈值并清仓。  
优势：改动少。  
代价：阈值判断分散在主循环，风险逻辑不集中，不满足“系统性修改”要求。

**备选方案（C）**：继续通过 reason 文本判断清仓类型并强制 ELO。  
优势：实现快。  
代价：补丁式、不可维护，违反规范（不推荐）。

## 详细设计

### 核心数据与常量

- 新增常量：
  - `BULL_WARRANT_LIQUIDATION_DISTANCE_PERCENT = 0.5`
  - `BEAR_WARRANT_LIQUIDATION_DISTANCE_PERCENT = -0.5`
  - `WARRANT_LIQUIDATION_ORDER_TYPE: OrderTypeConfig = 'ELO'`
- 新增信号字段：
  - `orderTypeOverride?: OrderTypeConfig | null`（订单类型覆盖，优先级高于全局配置）
  - `isProtectiveLiquidation?: boolean`（显式清仓标记，避免 reason 文本判断）
- 新增风险判定结果类型：
  - `WarrantDistanceLiquidationResult`，包含 `shouldLiquidate`、`warrantType`、`distancePercent` 与 `reason`。

### 清仓触发与执行流程

1. 主循环 `processMonitor` 在价格变化时调用 `riskChecker.checkWarrantDistanceLiquidation`（做多与做空分别判断）。  
2. 若触发清仓：
   - 生成 `SELLCALL/SELLPUT` 信号（对象池获取）。
   - 设置 `orderTypeOverride = WARRANT_LIQUIDATION_ORDER_TYPE`。
   - 设置 `isProtectiveLiquidation = true`（用于清仓冷却与日志一致性）。
   - 补充 `symbolName`、`price`、`lotSize`、`reason`、`triggerTime`。
3. 执行 `trader.executeSignals` 后：
   - `orderRecorder.clearBuyOrders(...)` 清空订单记录。
   - `riskChecker.refreshUnrealizedLossData(...)` 刷新浮亏数据。
4. 清仓信号释放回对象池，避免泄漏。

### 订单类型解析（系统性修改）

订单执行器新增统一的 `resolveOrderType()`：
1. 若 `signal.orderTypeOverride` 存在 → 使用覆盖值。
2. 若 `signal.isProtectiveLiquidation === true` → 使用全局 `liquidationOrderType`。
3. 否则 → 使用全局 `tradingOrderType`。

此流程保证：牛熊证清仓使用独立常量 ELO；保护性清仓仍用全局配置。

### 触发保护（避免重复清仓）

为防止在极端行情下每秒重复触发清仓，新增监控状态字段：
- `lastWarrantDistanceLiquidationAtMs: number | null`
并引入冷却常量（如 `WARRANT_DISTANCE_LIQUIDATION_COOLDOWN_SECONDS`，默认 10-30 秒范围内，按实际需要调优）。

## 任务拆解

### Task 1: 类型与常量扩展

**Files:**
- Modify: `src/constants/index.ts`
- Modify: `src/types/index.ts`
- Modify: `src/core/risk/types.ts`

**Step 1: 添加常量**

```ts
export const BULL_WARRANT_LIQUIDATION_DISTANCE_PERCENT = 0.5;
export const BEAR_WARRANT_LIQUIDATION_DISTANCE_PERCENT = -0.5;
export const WARRANT_LIQUIDATION_ORDER_TYPE: OrderTypeConfig = 'ELO';
```

**Step 2: 扩展 Signal 与 RiskChecker 接口**

```ts
export type WarrantDistanceLiquidationResult = {
  readonly shouldLiquidate: boolean;
  readonly warrantType?: WarrantType;
  readonly distancePercent?: number | null;
  readonly reason?: string;
};

export type Signal = {
  // ...
  orderTypeOverride?: OrderTypeConfig | null;
  isProtectiveLiquidation?: boolean;
};

export interface RiskChecker {
  // ...
  checkWarrantDistanceLiquidation(
    symbol: string,
    isLongSymbol: boolean,
    monitorCurrentPrice: number,
  ): WarrantDistanceLiquidationResult;
}
```

### Task 2: 风险模块实现距回收价清仓判定

**Files:**
- Modify: `src/core/risk/warrantRiskChecker.ts`
- Modify: `src/core/risk/index.ts`

**Step 1: 在 warrantRiskChecker 中实现判定**

- 复用已有 `calculateDistancePercent` 与回收价/监控价校验逻辑。
- 使用新阈值常量生成 `WarrantDistanceLiquidationResult`。

**Step 2: 在 risk/index.ts 中暴露接口**

- `createRiskChecker` 返回 `checkWarrantDistanceLiquidation`，委托给 `warrantRiskChecker`。

### Task 3: 主循环清仓触发与执行

**Files:**
- Modify: `src/main/processMonitor/index.ts`
- Modify: `src/main/processMonitor/utils.ts`
- Modify: `src/utils/helpers/index.ts`（初始化新增状态字段）
- Modify: `src/types/index.ts`（MonitorState 新字段）

**Step 1: 添加状态字段与初始化**

- `MonitorState` 增加 `lastWarrantDistanceLiquidationAtMs`。
- `initMonitorState()` 初始化为 `null`。

**Step 2: 生成并执行清仓信号**

- 在 `processMonitor` 的价格变化分支中加入清仓判定。
- 触发时创建信号并设置：
  - `orderTypeOverride = WARRANT_LIQUIDATION_ORDER_TYPE`
  - `isProtectiveLiquidation = true`
  - `reason` 写明阈值与距回收价百分比
- 成功后清空订单记录并刷新浮亏。

### Task 4: 订单执行器优先处理覆盖订单类型

**Files:**
- Modify: `src/core/trader/orderExecutor.ts`

**Step 1: 统一解析订单类型**

```ts
const orderType = resolveOrderType(signal, global);
```

**Step 2: 取消 reason 文本判断**

- `isLiquidationSignal()` 改为基于 `signal.isProtectiveLiquidation === true`。
- 所有保护性清仓信号显式设置该字段（见 Task 5）。

### Task 5: 保护性清仓信号显式标记

**Files:**
- Modify: `src/core/unrealizedLossMonitor/index.ts`

**Step 1: 设置保护性清仓标记**

```ts
liquidationSignal.isProtectiveLiquidation = true;
```

**Step 2: 保留 reason 文本仅用于日志展示**

## 验证与测试计划

- 运行静态检查：`npm run lint`、`npm run type-check`（必须通过）。
- 手动验证场景：
  1. 将监控标的价格模拟逼近回收价（牛/熊证分别验证）。
  2. 观察是否触发清仓，且订单类型日志为 ELO。
  3. 非牛/熊证标的不触发清仓。
  4. 触发后订单记录清空、浮亏数据刷新。

## 风险与回滚

- 订单类型覆盖仅对牛熊证清仓信号生效，其他流程不变。
- 若触发逻辑异常，可临时调高阈值常量或禁用清仓触发调用（保留风险检查不变）。

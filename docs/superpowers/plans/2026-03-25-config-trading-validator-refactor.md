# Config Trading Validator Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `src/config/config.trading.ts` 与 `src/config/config.validator.ts` 重构为目录化模块，并在不改变任何现有逻辑的前提下完成全仓库路径迁移。

**Architecture:** 采用与 `src/config/auth` 对齐的目录化结构：`trading` 与 `validator` 各自拆成 `index.ts`、`types.ts`、`utils.ts`。`index.ts` 保留模块公开入口与必要的聚合编排，叶子级私有工具函数下沉到 `utils.ts`，仅模块内部使用的类型下沉到本地 `types.ts`，继续被公共工具或外部调用方依赖的类型留在 `src/config/types.ts`。

**Tech Stack:** TypeScript, Bun, Node.js, Longbridge SDK, bun test, ESLint, TypeScript strict mode

---

## 文件结构映射

### 新建文件

- `src/config/trading/index.ts`
  - trading 模块入口，导出 `createMultiMonitorTradingConfig`
- `src/config/trading/types.ts`
  - trading 私有参数类型：`BoundedNumberConfig`、`MinimumNumberConfig`
- `src/config/trading/utils.ts`
  - trading 私有解析辅助函数与单 monitor 配置组装函数
- `src/config/validator/index.ts`
  - validator 模块入口，导出 `validateAllConfig`、`validateRuntimeSymbolsFromQuotesMap`
- `src/config/validator/types.ts`
  - validator 私有校验类型：`ValidationResult`、`TradingValidationResult`、`SymbolValidationContext`、`DuplicateSymbol`、`SignalConfigKey`
- `src/config/validator/utils.ts`
  - validator 叶子级校验与格式化函数

### 修改文件

- `src/config/types.ts`
  - 移除真正下沉到 trading / validator 模块内部的类型
  - 保留公共边界类型：`ConfigValidationError`、`RuntimeSymbolValidationInput`、`RuntimeSymbolValidationResult`、`ComparisonOperator`、`ParsedCondition`、`ParsedConditionGroup`
- `src/app/runtime/createPreGateRuntime.ts`
  - 更新 config 导入路径
- `src/app/runApp.ts`
  - 更新 config 导入路径
- `tests/config/tradingConfig.failfast.business.test.ts`
  - 更新 config 导入路径
- `tests/config/autoSearchDistanceConfig.business.test.ts`
  - 更新 config 导入路径
- `tests/config/smartCloseTimeoutConfig.business.test.ts`
  - 更新 config 导入路径
- `tests/config/periodicSwitchConfig.business.test.ts`
  - 更新 config 导入路径
- `tests/config/autoSearchDistanceConfig.business.test.ts`
  - 更新 config 导入路径
- `tests/config/orderMonitorBuyChaseControlConfig.business.test.ts`
  - 更新 config 导入路径
- `tests/config/longbridgeOAuthConfig.business.test.ts`
  - 更新 config 导入路径

### 删除文件

- `src/config/config.trading.ts`
- `src/config/config.validator.ts`

## 约束与不变量

- 不修改任何配置字段、默认值、错误文本、日志语义、错误聚合顺序。
- `validateTradingConfig` 保留为 validator 模块内部聚合校验流程，不拆散职责。
- `RuntimeSymbolValidationInput` / `RuntimeSymbolValidationResult` 继续保留在 `src/config/types.ts`，因为 `src/app/types.ts` 仍直接消费。
- 删除旧文件前必须完成全仓库 import sweep，确保不再残留对 `config.trading.js` / `config.validator.js` 的引用。

### Task 1: 新建目录化模块骨架

**Files:**

- Create: `src/config/trading/index.ts`
- Create: `src/config/trading/types.ts`
- Create: `src/config/trading/utils.ts`
- Create: `src/config/validator/index.ts`
- Create: `src/config/validator/types.ts`
- Create: `src/config/validator/utils.ts`

- [ ] **Step 1: 新建 trading 目录与 3 个目标文件**
- [ ] **Step 2: 新建 validator 目录与 3 个目标文件**
- [ ] **Step 3: 确认文件路径与 spec 一致，不引入旧入口转发文件**

### Task 2: 拆分 trading 模块

**内部导入检查：**

- 新目录下所有来自 `../types.js`、`../constants/index.js`、`../utils/logger/index.js`、`../types/config.js`、`../types/signal*.js`、`../config/utils.js` 的相对路径都必须按新目录位置重新校正。

**Files:**

- Create: `src/config/trading/index.ts`
- Create: `src/config/trading/types.ts`
- Create: `src/config/trading/utils.ts`
- Modify: `src/config/types.ts`
- Delete: `src/config/config.trading.ts`
- Test: `tests/config/orderMonitorBuyChaseControlConfig.business.test.ts`
- Test: `tests/config/periodicSwitchConfig.business.test.ts`

- [ ] **Step 1: 在 `src/config/trading/types.ts` 定义 `BoundedNumberConfig` 与 `MinimumNumberConfig`**
- [ ] **Step 2: 在 `src/config/trading/utils.ts` 迁移所有 trading 私有工具函数**
- [ ] **Step 3: 在 `src/config/trading/index.ts` 保留 `createMultiMonitorTradingConfig` 顶层编排**
- [ ] **Step 4: 从 `src/config/types.ts` 删除已下沉的 trading 私有类型，保留公共类型不动**
- [ ] **Step 5: 删除旧的 `src/config/config.trading.ts`**
- [ ] **Step 6: 运行 trading 相关最小测试确认通过**

Run: `bun test tests/config/orderMonitorBuyChaseControlConfig.business.test.ts tests/config/periodicSwitchConfig.business.test.ts` Expected: PASS

### Task 3: 拆分 validator 模块

**内部导入检查：**

- 新目录下所有来自 `../constants/index.js`、`../types/config.js`、`../types/quote.js`、`../utils/logger/index.js`、`../config/utils.js`、`../config/types.js`、`../auth/utils.js` 的相对路径都必须按新目录位置重新校正。
- 尤其要显式核对 `auth` 目录相关导入，保证 `src/config/validator/index.ts` 指向的新相对路径正确，但不修改 `src/config/auth` 结构。

**Files:**

- Create: `src/config/validator/index.ts`
- Create: `src/config/validator/types.ts`
- Create: `src/config/validator/utils.ts`
- Modify: `src/config/types.ts`
- Delete: `src/config/config.validator.ts`
- Test: `tests/config/smartCloseTimeoutConfig.business.test.ts`
- Test: `tests/config/longbridgeOAuthConfig.business.test.ts`

- [ ] **Step 1: 在 `src/config/validator/types.ts` 定义 validator 私有类型**
- [ ] **Step 2: 在 `src/config/validator/utils.ts` 迁移叶子级校验与格式化函数**
- [ ] **Step 3: 在 `src/config/validator/index.ts` 保留 `validateAllConfig`、`validateRuntimeSymbolsFromQuotesMap` 与 `validateTradingConfig` 聚合流程**
- [ ] **Step 4: 从 `src/config/types.ts` 删除已下沉的 validator 私有类型，保留公共类型不动**
- [ ] **Step 5: 删除旧的 `src/config/config.validator.ts`**
- [ ] **Step 6: 运行 validator 相关最小测试确认通过**

Run: `bun test tests/config/smartCloseTimeoutConfig.business.test.ts tests/config/longbridgeOAuthConfig.business.test.ts` Expected: PASS

### Task 4: 迁移 app 与测试引用

**Files:**

- Modify: `src/app/runtime/createPreGateRuntime.ts:10-12`
- Modify: `src/app/runApp.ts:9`
- Modify: `tests/config/tradingConfig.failfast.business.test.ts:11-12`
- Modify: `tests/config/smartCloseTimeoutConfig.business.test.ts:8-9`
- Modify: `tests/config/periodicSwitchConfig.business.test.ts:9-10`
- Modify: `tests/config/autoSearchDistanceConfig.business.test.ts:9-10`
- Modify: `tests/config/orderMonitorBuyChaseControlConfig.business.test.ts:8`
- Modify: `tests/config/longbridgeOAuthConfig.business.test.ts:8`

- [ ] **Step 1: 更新 `src/app/runtime/createPreGateRuntime.ts` 的导入路径**
- [ ] **Step 2: 更新 `src/app/runApp.ts` 的导入路径**
- [ ] **Step 3: 更新全部 config 相关测试文件导入路径**
- [ ] **Step 4: 运行 grep 确认仓库已无旧路径引用**

Run: `grep-equivalent via Grep tool for config\.(trading|validator)\.js` Expected: 仅文档中保留说明，源码与测试不再引用旧入口

### Task 5: 跑完整验证并清理格式

**说明：**

- `tests/app/createPreGateRuntime.test.ts` 与 `tests/app/runApp.test.ts` 不属于本次修改文件，但属于必须执行的回归验证，用于确认 app 装配链路行为不变。

**Files:**

- Modify: `src/config/trading/index.ts`
- Modify: `src/config/trading/types.ts`
- Modify: `src/config/trading/utils.ts`
- Modify: `src/config/validator/index.ts`
- Modify: `src/config/validator/types.ts`
- Modify: `src/config/validator/utils.ts`
- Modify: `src/config/types.ts`
- Modify: `src/app/runtime/createPreGateRuntime.ts`
- Modify: `src/app/runApp.ts`
- Modify: `tests/config/*.test.ts`
- Test: `tests/app/createPreGateRuntime.test.ts`
- Test: `tests/app/runApp.test.ts`

- [ ] **Step 1: 运行 `bun format` 并修复格式问题**
- [ ] **Step 2: 运行 `bun lint` 并修复 lint 问题**
- [ ] **Step 3: 运行 `bun type-check` 并修复类型问题**
- [ ] **Step 4: 运行本次受影响的 config 与 app 测试集合确认行为不变**

Run: `bun test tests/config/tradingConfig.failfast.business.test.ts tests/config/smartCloseTimeoutConfig.business.test.ts tests/config/periodicSwitchConfig.business.test.ts tests/config/autoSearchDistanceConfig.business.test.ts tests/config/orderMonitorBuyChaseControlConfig.business.test.ts tests/config/longbridgeOAuthConfig.business.test.ts tests/app/createPreGateRuntime.test.ts tests/app/runApp.test.ts` Expected: PASS

### Task 6: 最终自检

**Files:**

- Review only: `src/config/trading/index.ts`
- Review only: `src/config/trading/types.ts`
- Review only: `src/config/trading/utils.ts`
- Review only: `src/config/validator/index.ts`
- Review only: `src/config/validator/types.ts`
- Review only: `src/config/validator/utils.ts`
- Review only: `src/config/types.ts`

- [ ] **Step 1: 自检是否存在 re-export、无用兼容层、重复工具函数**
- [ ] **Step 2: 自检 `types.ts` / `utils.ts` 是否符合项目规范**
- [ ] **Step 3: 确认未改动任何业务逻辑、默认值、错误顺序、日志语义**
- [ ] **Step 4: 记录验证结果并准备交付**

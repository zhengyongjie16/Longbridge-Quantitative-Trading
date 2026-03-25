# config trading / validator 目录化重构设计

## 背景

当前 `src/config/config.trading.ts` 与 `src/config/config.validator.ts` 同时承担模块入口、私有工具函数和私有类型定义三类职责，单文件边界过宽。

仓库内 `src/config/auth` 已采用目录化组织：

- `index.ts`：模块公开入口
- `types.ts`：模块内类型定义文件
- `utils.ts`：模块内工具函数文件

这里的 `auth` 仅作为目录结构参考，不等于“放进目录里的类型都自动变成私有类型”。是否属于私有边界，必须以当前实际导入关系为准。

本次重构目标是将 trading 与 validator 模块对齐到相同结构，并将各自确认只在模块内部使用的类型与工具函数收敛到自己的模块目录中，在不改变原有逻辑、不增加兼容层的前提下完成路径迁移。

## 目标

- 将 `config.trading.ts` 重构为 `src/config/trading/` 目录结构。
- 将 `config.validator.ts` 重构为 `src/config/validator/` 目录结构。
- 确认仅在模块内部使用的类型，下沉到各自模块的 `types.ts` 中。
- 确认仅在模块内部使用的工具函数，下沉到各自模块的 `utils.ts` 中。
- 外部调用方改为直接引用新目录入口，不保留旧文件转发。
- 删除旧的 `src/config/config.trading.ts` 与 `src/config/config.validator.ts`。
- 保证运行时行为、配置解析结果、错误信息与验证逻辑保持不变。

## 非目标

- 不修改 `src/config/auth` 的现有结构。
- 不将 trading / validator 私有逻辑再次上提到 `src/config/utils.ts` 或 `src/config/types.ts`。
- 不调整任何配置字段、默认值、校验范围、错误文本与日志语义。
- 不引入兼容入口或补丁式过渡文件。

## 方案对比

### 方案 A：直接目录化并切换新路径（采用）

做法：

- 新建 `src/config/trading/{index,types,utils}.ts`
- 新建 `src/config/validator/{index,types,utils}.ts`
- 将现有入口函数保留在各自 `index.ts`
- 将仅模块内部使用的辅助函数迁入各自 `utils.ts`
- 将仅模块内部使用的类型迁入各自 `types.ts`
- 统一修改调用方导入路径
- 删除旧文件

优点：

- 边界清晰，完全对齐 `auth` 模式
- 私有实现内聚，不再继续污染 `src/config` 根层
- 没有兼容层，结构最终态明确
- 改动范围可控，行为保持不变

缺点：

- 需要同步改动已有导入路径

### 方案 B：只新建目录，但保留大部分私有逻辑在 `index.ts`

不采用。

原因：目录形式变化了，但职责没有真正收敛，无法满足“私有类型和工具函数收敛到自己的模块文件夹中”的目标。

### 方案 C：顺便继续抽公共层

不采用。

原因：本次目标是目录化收敛，而不是额外做公共抽象；继续上提会引入新的边界变化，不利于控制重构风险。

## 最终设计

### 1. trading 模块边界

新增目录：`src/config/trading/`

#### `src/config/trading/index.ts`

职责：

- 保留模块公开入口 `createMultiMonitorTradingConfig`
- 负责交易配置的顶层编排：扫描 monitor 索引、组装 monitors、解析 global 配置并返回 `MultiMonitorTradingConfig`
- 仅依赖公共配置工具、常量、类型，以及本模块私有 `utils.ts` / `types.ts`

#### `src/config/trading/types.ts`

收纳仅供 trading 模块内部使用的参数类型：

- `BoundedNumberConfig`
- `MinimumNumberConfig`

这两个类型不再继续放在 `src/config/types.ts`。

#### `src/config/trading/utils.ts`

收纳仅供 trading 模块内部使用的辅助函数：

- `parseSignalConfigFromEnv`
- `parseBoundedNumberConfig`
- `parseFailFastBoundedNumberConfig`
- `parseFailFastMinimumNumberConfig`
- `getPercentValueConfig`
- `mapOrderTypeConfig`
- `parseMonitorConfig`

设计原则：

- `index.ts` 只保留顶层装配逻辑
- monitor 单项解析与数值解析细节都下沉到 `utils.ts`
- 所有函数逻辑保持现状，不修改行为与默认值

### 2. validator 模块边界

新增目录：`src/config/validator/`

#### `src/config/validator/index.ts`

职责：

- 保留对外公开函数：
  - `validateAllConfig`
  - `validateRuntimeSymbolsFromQuotesMap`
- 负责聚合 auth 校验结果与 trading 校验结果
- 负责最终日志输出与 `ConfigValidationError` 抛出

说明：

- `validateTradingConfig` 作为 validator 模块内的聚合校验编排函数，保留在 `index.ts`，不拆散其职责。
- `validator/utils.ts` 只收纳叶子级辅助函数与格式化函数，不承接 `validateTradingConfig` 这类聚合流程。
- `validateAllConfig -> auth 校验 -> trading 校验 -> allErrors/allMissingFields 聚合 -> logger 输出/抛错` 的顺序必须完全保持现状。

#### `src/config/validator/types.ts`

收纳仅供 validator 模块内部使用的私有类型：

- `ValidationResult`
- `TradingValidationResult`
- `SymbolValidationContext`
- `DuplicateSymbol`
- `SignalConfigKey`

说明：

- `RuntimeSymbolValidationInput` / `RuntimeSymbolValidationResult` 当前仍被 `src/app/types.ts` 直接消费，因此不能按“validator 私有类型”处理；它们应继续作为公共类型边界保留在 `src/config/types.ts`。
- `ConfigValidationError`、`ComparisonOperator`、`ParsedCondition`、`ParsedConditionGroup` 也继续留在现有公共 `src/config/types.ts`，因为它们仍被 `src/config/utils.ts` 或外部调用方依赖。
- `BoundedNumberConfig`、`MinimumNumberConfig` 会迁入 `src/config/trading/types.ts`，因为它们仅服务于 trading 模块内部。

#### `src/config/validator/utils.ts`

收纳仅供 validator 模块内部使用的辅助函数：

- `formatSymbolFormatError`
- `formatLiquidationCooldownConfig`
- `validateRequiredSymbol`
- `recordTradingSymbolUsage`
- `validateDegradedRangeRelationship`
- `validateLongbridgeAuthConfig`
- `validateCriticalBoundedNumberConfig`
- `validateCriticalMinimumNumberConfig`
- `validateMonitorSymbolIndexContinuity`
- `validateSymbolFromQuote`
- `validateMonitorConfig`

设计原则：

- `index.ts` 负责顶层编排与输出
- 细粒度校验与格式化函数全部下沉
- 所有校验条件、范围、错误文案和日志口径保持现状

### 3. 导入路径迁移

需要同步检查全仓库受影响调用方与类型边界：

- 运行时代码导入迁移：
  - `src/app/runtime/createPreGateRuntime.ts`
    - `../../config/config.validator.js` → `../../config/validator/index.js`
    - `../../config/config.trading.js` → `../../config/trading/index.js`
  - `src/app/runApp.ts`
    - `../config/config.validator.js` → `../config/validator/index.js`
- 测试代码导入迁移：
  - `tests/config/tradingConfig.failfast.business.test.ts`
  - `tests/config/smartCloseTimeoutConfig.business.test.ts`
  - `tests/config/periodicSwitchConfig.business.test.ts`
  - `tests/config/autoSearchDistanceConfig.business.test.ts`
  - `tests/config/orderMonitorBuyChaseControlConfig.business.test.ts`
  - `tests/config/longbridgeOAuthConfig.business.test.ts`
- 类型边界保持：
  - `src/app/types.ts` 继续依赖 `src/config/types.ts` 中的 `RuntimeSymbolValidationInput` 与 `RuntimeSymbolValidationResult`，本次不改为私有下沉。

本次不保留旧入口转发文件，调用方直接切到新路径；但公共类型边界仍需按现有外部依赖保留。删除旧文件前，必须先完成全仓库 import sweep，确保 repo 内不再残留对 `config.trading.js` / `config.validator.js` 的引用。

### 4. `src/config/types.ts` 保留项

本次重构后，`src/config/types.ts` 仍然是必要的公共边界文件，不会随目录化一起消失。至少保留：

- `ConfigValidationError`
- `RuntimeSymbolValidationInput`
- `RuntimeSymbolValidationResult`
- `ComparisonOperator`
- `ParsedCondition`
- `ParsedConditionGroup`

判断规则：

- 仍被 `src/config/utils.ts` 使用的类型，继续保留在公共 `src/config/types.ts`
- 仍被 `src/app/types.ts` 等外部调用方使用的类型，继续保留在公共 `src/config/types.ts`
- 只有确认不再被公共工具或外部调用方依赖的类型，才迁入对应模块目录

### 5. 删除旧文件

在新目录结构完成且调用方已迁移后，删除：

- `src/config/config.trading.ts`
- `src/config/config.validator.ts`

### 6. 逻辑不变性保证

本次重构必须保持以下行为完全不变：

- monitor 扫描与连续性校验逻辑
- trading/global 配置解析逻辑
- 数值默认值、边界与 fail-fast 行为
- signal 配置解析与日志语义
- validator 的错误收集顺序与错误文案
- auth 配置校验聚合方式
- runtime symbols 校验逻辑
- 所有现有公开函数签名

也就是说，这次是“模块边界重组”，不是“业务逻辑重写”。

## 数据流与依赖关系

### trading

`index.ts` → 调用 `utils.ts` 中的 monitor / number / signal 解析函数 → 组装 `MultiMonitorTradingConfig` → 返回给调用方与 validator

### validator

`index.ts` → 调用 `auth/utils.ts` 的 Longbridge 校验函数 → 调用本模块 `validateTradingConfig` → `validateTradingConfig` 再调用 `utils.ts` 中的各细粒度校验函数 → 汇总错误后记录日志或抛出 `ConfigValidationError`

## 错误处理

- 不新增错误兜底逻辑。
- 保持当前 fail-fast 与错误聚合策略：
  - trading 解析阶段仍在关键配置异常时抛出 `ConfigValidationError`
  - validator 阶段仍收集错误并在末尾统一抛出
- 不改动任何警告日志和错误日志文本，避免影响用户既有排查方式。

## 测试与验证

本次不新增新功能测试，验证重点是“重构后行为不变”：

1. 通过 TypeScript 编译与 lint 验证导入和类型边界正确
2. 通过 format 保证文件风格一致
3. 确认所有旧路径引用已迁移完成
4. 确认删除旧文件后无残留引用

执行顺序：

1. `bun format`
2. `bun lint`
3. `bun type-check`

## 实施步骤

1. 新建 trading 目录及其 `index.ts` / `types.ts` / `utils.ts`
2. 迁移 `config.trading.ts` 内部实现并保持导出不变
3. 新建 validator 目录及其 `index.ts` / `types.ts` / `utils.ts`
4. 迁移 `config.validator.ts` 内部实现并保持导出不变
5. 修改运行时代码导入路径，并确认 `src/app/types.ts` 依赖的公共类型边界保持不变
6. 校正 `src/config/types.ts` 的剩余职责，仅迁移真正的模块内部类型
7. 删除旧的 `config.trading.ts` 与 `config.validator.ts`
8. 运行 `bun format`、`bun lint`、`bun type-check`

## 风险点

- `src/config/types.ts` 中部分类型同时服务于公共 `src/config/utils.ts`，不能为了“目录化”而错误地下沉到 validator/trading 目录，否则会打破现有依赖关系。
- `validator` 中导出的运行时校验返回类型若迁移不当，可能导致 `runApp.ts` 一侧导入类型丢失；因此需要基于实际 import 关系做最小迁移。
- 删除旧文件前必须先完成所有路径替换，否则会留下编译错误。

## 结论

采用方案 A：直接目录化并切换新路径。

这是当前最短、最清晰、最符合现有 `auth` 模块组织方式的重构路径，同时能够满足“私有类型和工具函数收敛到自己的模块文件夹中”且“不影响原有逻辑”的要求。

# Issue 2 系统性重构方案（全链路循环依赖清零）

## 1. 背景与问题定义

当前工程循环依赖分为两层：

### 1.1 运行时循环（必须清零）

1. `src/utils/logger/index.ts -> src/utils/helpers/index.ts -> src/utils/logger/index.ts`
2. `src/utils/logger/index.ts -> src/utils/index.ts -> src/utils/logger/index.ts`
3. `src/utils/index.ts -> src/main/startup/seat.ts -> src/utils/index.ts`
4. `src/utils/index.ts -> src/main/startup/seat.ts -> src/services/autoSymbolFinder/index.ts -> src/utils/index.ts`
5. `src/services/indicators/utils.ts -> src/services/indicators/{ema,kdj,macd,mfi,psy,rsi}.ts -> src/services/indicators/utils.ts`

### 1.2 类型层循环（必须清零）

1. `src/types/services.ts -> src/core/doomsdayProtection/types.ts -> ... -> src/types/services.ts`
2. `src/core/orderRecorder/types.ts <-> src/types/services.ts`

这些循环会导致：

1. 模块初始化顺序敏感，存在隐性启动风险。
2. 基础层（utils/types）被业务层反向污染。
3. 依赖边界模糊，后续重构成本持续放大。

## 2. 重构目标

1. 一次性清零运行时循环与类型层循环（非局部补丁）。
2. 恢复严格单向依赖分层。
3. 保持业务逻辑、交易行为、日志语义不变，仅做结构性重构。
4. 全面符合 `typescript-project-specifications` 规范。

## 3. 强制约束（必须遵守）

1. 不采用兼容层、不保留过渡 re-export。
2. 每个调用方直接从定义源模块导入，不经中间聚合转发。
3. `src/utils/**` 不得依赖 `src/main/**`、`src/core/**`、`src/services/**`。
4. `src/types/**` 不得依赖 `src/core/**`、`src/main/**`、`src/services/**`。
5. `src/utils/**` 新增模块的对外入口文件统一命名为 `index.ts`；仅模块内部辅助文件可使用 `utils.ts`；新增类型文件统一命名为 `types.ts`。
6. 类型重构仅允许单一路径的中立类型上提方案，禁止结构兼容分支。
7. 严禁改变函数签名、默认值、判定边界、日志文案与副作用时机。

### 3.1 命名统一决策（新增）

1. `src/utils/**` 采用目录模块入口模式，统一使用 `**/index.ts` 作为对外导入入口。
2. `utils.ts` 仅允许作为模块内部辅助文件（非模块入口）；调用方不得以其替代模块入口。
3. 本次从 `src/utils/index.ts` 拆出的目标文件均按 `**/index.ts` 落地，避免与现有 `src/utils/**` 入口命名风格冲突。

## 4. 目标分层模型

1. `src/constants/**` + `src/types/**`：基础层
2. `src/utils/**`：基础工具层
3. `src/services/**` + `src/core/**` + `src/main/**`：业务层
4. `src/index.ts`：组装层

依赖方向必须单向：

`constants/types -> utils -> services/core/main -> index`

## 5. 完整改造范围（唯一方案）

### 5.1 拆解并删除 `src/utils/index.ts`

将以下能力从 `src/utils/index.ts` 迁移到源模块（新增模块入口文件统一 `index.ts`）：

1. `src/utils/runtime/index.ts`

- `resolveRuntimeProfile`
- `resolveLogRootDir`
- `shouldInstallGlobalProcessHooks`

2. `src/utils/error/index.ts`

- `formatError`

3. `src/utils/display/index.ts`

- `formatSymbolDisplay`
- `isSellAction`

4. `src/utils/time/index.ts`

- `toHongKongTimeIso`
- `toHongKongTimeLog`

5. `src/utils/refreshGate/index.ts`

- `createRefreshGate`

6. `src/utils/positionCache/index.ts`

- `createPositionCache`

7. `src/utils/tradingTime/index.ts`

- `getHKDateKey`
- `isInContinuousHKSession`
- `isWithinMorningOpenProtection`
- `isWithinAfternoonOpenProtection`
- `calculateTradingDurationMsBetween`
- `getTradingMinutesSinceOpen`

迁移完成后删除 `src/utils/index.ts`，全仓改为直接源模块导入。

### 5.2 组装层逻辑迁入 `main/bootstrap`

以下函数迁出 utils，放入业务组装层：

1. `src/main/bootstrap/runtimeValidation.ts`

- `pushRuntimeValidationSymbol`
- `resolveSeatSymbolsByMonitor`

2. `src/main/bootstrap/rebuild.ts`

- `createTradingDayInfoResolver`
- `runOpenRebuild`

3. `src/main/bootstrap/queueCleanup.ts`

- `clearQueuesForDirectionWithLog`

4. `src/main/bootstrap/types.ts`

- 承载 bootstrap 相关类型
- 将 `src/types/index.ts` 中仅 bootstrap 使用的类型迁入此文件

迁移完成后删除 `src/types/index.ts`。

### 5.3 logger/helpers 断环改造

1. 新建 `src/utils/primitives/index.ts`

- `isRecord`
- `toHongKongTimeLog`

2. `src/utils/logger/index.ts` 改为仅依赖：

- `src/utils/primitives/index.ts`
- `src/utils/runtime/index.ts`
- `src/constants/**`

3. `src/utils/helpers/index.ts` 移除对 logger 的导入。

4. `sleep` 从 `src/utils/helpers/index.ts` 迁移到 `src/main/utils.ts`，
   保持原有行为、日志文案和异常路径完全一致。

### 5.4 startup/autoSymbolFinder 断环改造

1. `src/main/startup/seat.ts` 改为直接从 `src/utils/tradingTime/index.ts` 导入 `getHKDateKey`。
2. `src/services/autoSymbolFinder/index.ts` 改为直接从 `src/utils/error/index.ts` 导入 `formatError`。
3. 全仓替换所有 `from '.../utils/index.js'` 为源模块导入。

### 5.5 indicators 循环组改造（新增必做）

1. `src/services/indicators/utils.ts` 收敛为纯共享工具文件，只保留：

- `toNumber`
- `roundToFixed2`
- `validatePercentage`
- `logDebug`
- `initEmaStreamState`
- `feedEmaStreamState`
- `isValidKDJ`
- `isValidMACD`

2. 新建 `src/services/indicators/snapshotBuilder.ts`，承载：

- `getCandleFingerprint`
- `buildIndicatorSnapshot`

3. `snapshotBuilder.ts` 单向依赖 `ema/kdj/macd/mfi/psy/rsi`；
   `ema/kdj/macd/mfi/psy/rsi` 仅依赖 `utils.ts`，不得反向依赖 `snapshotBuilder.ts`。

### 5.6 类型循环清理（唯一中立上提路径）

1. 在 `src/types/services.ts` 内定义并统一承载以下跨层公共类型：

- `PendingSellInfo`
- `SellableOrderStrategy`
- `SellableOrderSelectParams`
- `SellableOrderResult`

2. `src/types/services.ts` 删除对以下业务类型文件的导入：

- `src/core/doomsdayProtection/types.ts`
- `src/core/orderRecorder/types.ts`

3. `RiskCheckContext` 中 `doomsdayProtection` 字段改为最小契约接口（仅保留实际使用行为契约），
   不再反向依赖 `core/doomsdayProtection/types.ts`。

4. `src/core/orderRecorder/types.ts` 改为引用 `src/types/services.ts` 中上述共享类型，
   并删除本地重复定义。

5. 新建 `src/types/queue/types.ts`，定义 `QueueClearResult`；
   `src/main/processMonitor/types.ts` 与 `src/utils/utils.ts`（内部辅助文件，非模块入口）均改为从该文件导入。

6. 重构完成后要求：

- `src/types/**` 不得出现 `from '../core/'` 等业务层导入
- `src/utils/**` 不得出现 `from '../main/'` 等业务层导入

## 6. 实施步骤（按批次执行）

### 批次 A：创建目标模块并迁移实现

1. 在目标目录新建 `index.ts` / `types.ts` 文件；若目标目录已存在 `index.ts`，则在原文件内迁移实现，不新增并行入口文件。
2. 逐函数迁移，保持函数体、签名、默认值、日志文案完全一致。
3. 同步迁移 bootstrap 专用类型到 `src/main/bootstrap/types.ts`。

### 批次 B：替换生产代码导入

1. 全仓替换 `src/**` 对 `src/utils/index.ts` 的引用。
2. 全仓替换 `src/**` 中 `indicators` 相关导入到新边界。
3. 完成 `types/services.ts` 与 `core/orderRecorder/types.ts` 的类型来源收敛。

### 批次 C：替换测试代码导入

1. 全仓替换 `tests/**` 的旧路径导入。
2. 补齐所有受影响测试的类型导入与模块路径。

### 批次 D：删除旧文件与重复定义

1. 删除 `src/utils/index.ts`。
2. 删除 `src/types/index.ts`。
3. 删除被中立上提后在 `core` 内重复的类型定义。
4. 清理全部无用导入、无用类型、无用注释。

### 批次 E：验证与收敛

1. `bun run type-check`
2. `bun run lint`
3. `bun run build`
4. `madge --extensions ts --ts-config tsconfig.json --circular src/`
5. `madge --circular dist/src`

## 7. 风险控制（业务零偏移）

1. 仅允许结构迁移，不允许业务逻辑改写。
2. 对象池 acquire/release 路径不得变更。
3. 时间与交易时段判定边界不得变更。
4. 若出现行为差异，优先回查导入来源与函数迁移一致性，不得加入兼容代码。
5. 重点回归路径：`logger` 初始化、`startup seat`、`mainProgram`、`indicatorPipeline`、`orderRecorder`。

## 8. 验收标准

1. `madge --extensions ts --ts-config tsconfig.json --circular src/` 结果为 0。
2. `bun run build` 后 `madge --circular dist/src` 结果为 0。
3. `bun run type-check` 与 `bun run lint` 全通过。
4. 关键业务回归测试通过：

- `tests/services/indicators/business.test.ts`
- `tests/main/processMonitor/indicatorPipeline.business.test.ts`
- `tests/main/asyncProgram/monitorTaskProcessor/business.test.ts`
- `tests/integration/main-program-strict.integration.test.ts`
- `tests/integration/full-business-simulation.integration.test.ts`
- `tests/integration/periodic-auto-symbol-chain.integration.test.ts`
- `tests/services/autoSymbolManager/*.business.test.ts`

5. 仓库中不存在对 `src/utils/index.ts` 的任何引用与文件本体。
6. `src/types/**` 中不存在对 `src/core/**` 的导入。
7. `src/utils/**` 中不存在对 `src/main/**` 的导入。
8. 交易主流程行为与日志语义保持一致，无业务逻辑偏移。

## 9. 结果预期

1. 全链路循环依赖清零，启动顺序风险消除。
2. 分层边界恢复，类型与工具层不再被业务层反向污染。
3. 代码结构符合 TypeScript 项目规范，后续演进可维护性显著提升。

# Utils Catch-all Boundary Design

## 背景与目标

`src/utils/utils.ts` 当前同时承载 monitor context snapshot 解析、runtime validation 辅助判断、set 比较、queue cleanup 汇总、env 布尔解析、account display 格式化等多类 helper。它们的消费面分散在 `src/app`、`src/main`、`src/services` 与 `src/utils/runtime`，已经形成“不同 owner 的局部 helper 被上浮到祖父级公共 util”的 catch-all 结构问题。

本次设计目标不是重新组织整个 `src/utils/`，而是在不引入兼容层、不制造新的 catch-all 文件、不改变现有业务语义的前提下，把 `src/utils/utils.ts` 中现有 helper 按最近共同父级与真实 owner 落回清晰边界，并顺手消除 `src/types/queue.ts` 这一由 catch-all 外溢放大的次生上浮问题。

## 范围内问题

本次仅处理以下已确认问题：

1. `resolveMonitorContextSeatSnapshot` / `resolveMonitorContextRuntimeSnapshot` 目前位于 `src/utils/utils.ts`，但被 `src/app/context/createMonitorContexts.ts`、`src/main/businessEventProgram/seatProjection.ts`、`src/main/tradingRiskEventRuntime/routingIndex.ts`、`src/main/lifecycle/cacheDomains/seatDomain.ts`、`src/main/lifecycle/rebuildTradingDayState.ts` 消费，说明它们是 monitor context / seat snapshot 相关的中性 helper，而不是杂项 utils。
2. `shouldSkipRuntimeValidationSymbol` 只被 `src/app/startup/runtimeValidation.ts` 使用，属于单 owner 局部 helper，不应继续停留在公共 util。
3. `areStringSetsEqual` 只被 `src/main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts` 与 `src/main/monitorQuoteEventRuntime/switchWakeupRuntime.ts` 使用，属于同一 runtime 域内共享 helper。
4. `getQueueClearTotalRemoved` 只被 `src/main/seatRuntimeCleanupDispatcher/queueCleanup.ts` 使用，而 `src/types/queue.ts` 只定义 `QueueClearResult`，说明该 helper 与对应类型都属于 `seatRuntimeCleanupDispatcher` 局部边界。
5. `parseBooleanEnv` 只被 `src/utils/runtime/index.ts` 使用，应回收到 runtime 局部实现附近。
6. `formatNumber` / `formatAccountChannel` 只被 `src/services/accountDisplay/index.ts` 使用，应收回到账户展示 owner 附近。

## 范围外问题

本次明确不处理以下事项：

1. 不重组整个 `src/utils/` 顶层目录；问题集中在 `src/utils/utils.ts`，不是整个工具目录全面失真。
2. 不顺带推进 `src/services/`、`src/main/`、`src/constants/index.ts`、`src/types/services.ts` 的更大范围语义重构。
3. 不改变任何交易、恢复、风险检查、显示输出的业务语义；本次只做 helper 落点与依赖边界收口。
4. 不新增 re-export 兼容层；迁移完成后由调用方直接依赖最终落点。
5. 不把本轮问题上升为通用“集合工具库”“格式化工具库”或新的 omnibus helper 文件。

## 设计原则

### 1. 按最近共同父级落点

helper 应落在其真实消费面能够自然解释的位置，而不是继续堆到祖父级 `utils.ts`。跨多个链路但同属 seat / monitor context 语义的 helper，应放入对应中性子域；只服务单一 owner 的 helper，应直接靠近 owner。

### 2. 保持事件驱动架构边界

本次只收口静态 helper 的文件归属，不引入 fallback、兜底、兼容桥接或额外运行时层。调用路径保持显式，依赖方向保持当前事件驱动架构的可读性。

### 3. 局部 owner 优先于伪共享

若 helper 只有单一消费方，就应视为局部实现细节，不因为“未来可能复用”而提前上浮。只有已存在清晰多方消费面，才放入中性共享位置。

### 4. 类型与 helper 同域收口

若某个 helper 只服务某个局部边界，其输入输出类型也应优先与该边界同域放置，避免由 helper 上浮反向抬高类型层级。

### 5. 最小迁移，不做顺手抽象

本轮只拆现有确定混杂点，不趁机做额外抽象、命名体系重建或跨域“工具库化”。拆分完成后，每个 helper 的归属必须一眼可解释。

## 方案对比

### 方案 A：保留 `src/utils/utils.ts`，仅改名并按注释分段

**做法**

- 把 `src/utils/utils.ts` 改成更中性的名字，例如 `src/utils/helpers.ts`。
- 继续保留当前 helper，只通过分组注释区分 seat、runtime、display、queue、env。

**优点**

- 改动最少。
- 导入路径变化最小。

**缺点**

- 只改变文件名，不改变 catch-all 本质。
- 单 owner helper 仍然停留在公共层，边界问题原样保留。
- 会继续鼓励未来 helper 往同一文件堆叠。

**结论**

不推荐。该方案只做表面整理，没有解决本次问题的根因。

### 方案 B：按职责拆到若干新的通用 util 子文件

**做法**

- 新增类似 `src/utils/monitorContext.ts`、`src/utils/collections.ts`、`src/utils/display.ts`、`src/utils/env.ts`、`src/utils/queue.ts`。
- 将 `src/utils/utils.ts` 中的函数按主题分发到这些 util 子文件。

**优点**

- 比原文件更清晰。
- 可以较快消除单文件 catch-all。

**缺点**

- 容易把“一个 catch-all”拆成“多个小 catch-all”。
- 单 owner helper 仍被放在公共工具层，依旧没有按真实 owner 收口。
- `src/utils/queue.ts`、`src/utils/display.ts` 这类命名仍会弱化领域归属。

**结论**

部分优于现状，但仍不符合本仓库“按最近共同父级组织 helper”的边界规则，不作为推荐方案。

### 方案 C：按真实 owner 与最近共同父级就地收口

**做法**

- seat / monitor context 相关中性 helper 收到 `src/utils/seat/` 语义域。
- 只被单一模块使用的 helper 下沉到消费方同目录文件或同文件局部实现。
- `QueueClearResult` 与 `getQueueClearTotalRemoved` 一并收回 `src/main/seatRuntimeCleanupDispatcher/`。
- 删除 `src/utils/utils.ts`，调用方直接改依赖最终落点。

**优点**

- 直接消除 catch-all 根因。
- 依赖关系与 owner 更一致，后续新增 helper 更不容易继续上浮。
- 能同步清理 `src/types/queue.ts` 的不必要全局层级。

**缺点**

- 导入路径调整面相对更广。
- 需要一次性检查全部残留引用，避免迁移遗漏。

**结论**

推荐。它是本轮最小但真正完成边界收口的方案。

## 推荐方案

采用方案 C：按真实 owner 与最近共同父级就地收口，并彻底删除 `src/utils/utils.ts` 与 `src/types/queue.ts`。

推荐方案的关键判断如下：

1. `resolveMonitorContextSeatSnapshot` / `resolveMonitorContextRuntimeSnapshot` 已具备明确 seat / monitor context 语义，且仓内已有 `src/utils/seat/guards.ts`、`src/utils/seat/symbols.ts` 作为同域先例，因此应进入 `src/utils/seat/`，而不是留在祖父级 util。
2. `shouldSkipRuntimeValidationSymbol`、`parseBooleanEnv`、`formatNumber`、`formatAccountChannel`、`getQueueClearTotalRemoved` 都是单 owner helper，应分别回收到各自消费方边界，而不是继续保留共享外观。
3. `areStringSetsEqual` 虽被两个文件使用，但两个消费方同属 `src/main/monitorQuoteEventRuntime/`，因此应收为该 runtime 局部共享 helper，而不是全局集合工具。
4. `QueueClearResult` 只有 `seatRuntimeCleanupDispatcher` 真正需要；当前全局类型层级是由 catch-all helper 反向拉高，应在拆 helper 时一并收口。

## 最终文件落点

### 1. seat / monitor context 中性 helper

- 新增 `src/utils/seat/runtimeSnapshots.ts`
  - 承载 `resolveMonitorContextSeatSnapshot`
  - 承载 `resolveMonitorContextRuntimeSnapshot`

选择该落点的原因：这两个函数共享 `SymbolRegistry`、seat state、quote snapshot 的派生语义，且已存在 `src/utils/seat/` 作为中性 helper 域。

### 2. runtime validation 局部 helper

- 下沉到 `src/app/startup/runtimeValidation.ts` 文件内局部函数
  - 承载 `shouldSkipRuntimeValidationSymbol`

选择该落点的原因：该函数只有单一消费方，抽成单独共享文件只会制造新的伪公共面。

### 3. monitor quote runtime 局部共享 helper

- 新增 `src/main/monitorQuoteEventRuntime/stringSets.ts`
  - 承载 `areStringSetsEqual`

选择该落点的原因：该函数仅被 `monitorQuoteEventRuntime.ts` 与 `switchWakeupRuntime.ts` 共同消费，最近共同父级就是 `src/main/monitorQuoteEventRuntime/`。

### 4. queue cleanup helper 与类型

- 新增 `src/main/seatRuntimeCleanupDispatcher/utils.ts`
  - 承载 `getQueueClearTotalRemoved`
- 新增 `src/main/seatRuntimeCleanupDispatcher/types.ts`
  - 承载 `QueueClearResult`
- 删除 `src/types/queue.ts`

选择该落点的原因：helper 与类型都只服务 `seatRuntimeCleanupDispatcher`，应同域落点，避免全局类型层级被局部协议占用。

### 5. runtime env 解析 helper

- 下沉到 `src/utils/runtime/index.ts` 文件内局部函数
  - 承载 `parseBooleanEnv`

选择该落点的原因：只有该模块使用，且函数本身属于 runtime env 解析实现细节。

### 6. account display 格式化 helper

- 下沉到 `src/services/accountDisplay/index.ts` 文件内局部函数
  - 承载 `formatNumber`
  - 承载 `formatAccountChannel`

选择该落点的原因：两个函数只服务账户显示端口，独立成共享文件不会增加真实复用价值。

### 7. 清理旧 catch-all 文件

- 删除 `src/utils/utils.ts`

删除条件：所有调用方都已切换到最终落点，且仓内不存在残留引用。

## 迁移顺序

### 第 1 步：先建立目标落点

1. 新建 `src/utils/seat/runtimeSnapshots.ts`，复制 `resolveMonitorContextSeatSnapshot` 与 `resolveMonitorContextRuntimeSnapshot` 的现有实现。
2. 新建 `src/main/monitorQuoteEventRuntime/stringSets.ts`，复制 `areStringSetsEqual`。
3. 新建 `src/main/seatRuntimeCleanupDispatcher/types.ts` 与 `src/main/seatRuntimeCleanupDispatcher/utils.ts`，复制 `QueueClearResult` 与 `getQueueClearTotalRemoved`。

先建立新落点而不立即删除旧文件，可以把迁移风险控制在“导入切换”层，而不是“逻辑重写”层。

### 第 2 步：切换多方共享调用方

1. 把 `src/app/context/createMonitorContexts.ts`、`src/main/businessEventProgram/seatProjection.ts`、`src/main/tradingRiskEventRuntime/routingIndex.ts`、`src/main/lifecycle/cacheDomains/seatDomain.ts`、`src/main/lifecycle/rebuildTradingDayState.ts` 改为从 `src/utils/seat/runtimeSnapshots.ts` 导入。
2. 把 `src/main/monitorQuoteEventRuntime/monitorQuoteEventRuntime.ts` 与 `src/main/monitorQuoteEventRuntime/switchWakeupRuntime.ts` 改为从 `src/main/monitorQuoteEventRuntime/stringSets.ts` 导入。
3. 把 `src/main/seatRuntimeCleanupDispatcher/queueCleanup.ts` 改为从本目录 `types.ts` / `utils.ts` 导入。

### 第 3 步：回收单 owner helper

1. 在 `src/app/startup/runtimeValidation.ts` 内联或局部定义 `shouldSkipRuntimeValidationSymbol`，然后删掉对 `src/utils/utils.ts` 的对应导入。
2. 在 `src/utils/runtime/index.ts` 内局部定义 `parseBooleanEnv`，删掉对应导入。
3. 在 `src/services/accountDisplay/index.ts` 内局部定义 `formatNumber` 与 `formatAccountChannel`，删掉对应导入。

### 第 4 步：删除旧全局文件与旧类型文件

1. 删除 `src/types/queue.ts`。
2. 删除 `src/utils/utils.ts`。
3. 清理所有残留 import、类型引用、测试引用与内部链接路径。

### 第 5 步：做边界回归复核

1. 搜索 `src/utils/utils.ts` 与 `src/types/queue.ts` 的残留引用，应为零。
2. 复读新文件落点，确认没有把单 owner helper 又抽成新的伪共享文件。
3. 确认 `src/utils/seat/runtimeSnapshots.ts` 没有额外吸收本轮范围外 helper，避免新文件演化成新的 catch-all。

## 测试与验证

### 静态与结构验证

1. 搜索残留引用：
   - `src/utils/utils.ts`
   - `src/types/queue.ts`
2. 确认 `QueueClearResult` 只存在于 `src/main/seatRuntimeCleanupDispatcher/types.ts`。
3. 确认 `shouldSkipRuntimeValidationSymbol`、`parseBooleanEnv`、`formatNumber`、`formatAccountChannel` 不再以共享导出形式存在。

### 建议执行的测试

1. `tests/main/recovery/seatPreparation.business.test.ts`
   - 目的：确认 seat 相关 helper 迁移没有破坏席位恢复与绑定链路的既有行为。
2. `tests/core/trader/index.business.test.ts`
   - 目的：确认运行期主要装配与交易链路未因 monitor context snapshot helper 迁移受到影响。
3. 与 `monitorQuoteEventRuntime` 直接相关的 focused tests（若已有对应测试文件，则执行该文件；若暂无，则至少运行覆盖 `switchWakeupRuntime` 与 `monitorQuoteEventRuntime` 的现有测试集合）。
   - 目的：确认 `areStringSetsEqual` 迁移不改变 retained set 去重语义。
4. `bun lint`
5. `bun type-check`

### 运行时验证重点

1. Monitor context 构建链路仍能正确派生 `longSymbol`、`shortSymbol`、`monitorQuote` 与名称字段。
2. Runtime validation 仍只收集有效且未重复的必选标的。
3. Monitor quote runtime 的 retained symbol 去重行为保持不变。
4. Queue cleanup 的 removed total 汇总值保持不变。
5. Account display 的数字与账户渠道文本格式化保持不变。

## 风险与不做项

### 风险

1. **残留引用风险**：`src/utils/utils.ts` 当前消费面分散，若迁移顺序不完整，容易在删除旧文件后留下编译错误。
2. **新文件再次变宽风险**：`src/utils/seat/runtimeSnapshots.ts` 是本轮唯一新增的中性共享 helper 文件，必须严格限制只承载 seat / monitor context snapshot 相关逻辑，避免再次演化为小型 catch-all。
3. **局部类型遗漏风险**：`QueueClearResult` 下沉时，若测试或辅助模块仍引用旧路径，会导致类型路径残留。

### 不做项

1. 不为迁移保留兼容 re-export。
2. 不为了“对称性”额外创建 `src/utils/display/`、`src/utils/env/`、`src/utils/collections/` 等新公共目录。
3. 不在本轮顺手统一注释风格、命名风格或做范围外整理。
4. 不把 `src/utils/seat/runtimeSnapshots.ts` 扩展成席位全能工具文件；只放本轮已确认的两个 snapshot helper。

## 推荐实施结论

本轮最合适的动作是：把真正共享的 seat / runtime snapshot helper 放回 `src/utils/seat/`，把其余单 owner 或局部共享 helper 全部收回各自边界，并同步删除 `src/utils/utils.ts` 与 `src/types/queue.ts`。这样既能最小化改动范围，又能真正消除 catch-all 与次生类型上浮，而不会引入新的兼容层或新的伪共享工具文件。

## 自审结论

已逐项检查本 spec 是否覆盖背景、范围、原则、方案对比、推荐方案、最终落点、迁移顺序、测试验证、风险与不做项；文中未保留 TBD、TODO 或“后续再看”式占位表述。推荐方案、文件落点与迁移顺序彼此一致，没有互相冲突的路径或所有权描述。

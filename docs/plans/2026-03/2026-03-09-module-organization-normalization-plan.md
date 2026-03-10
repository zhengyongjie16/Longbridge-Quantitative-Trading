# 模块组织规范化重构方案

## 1. 文档目的

本文档用于对当前新架构下的目录组织进行一次完整、系统、可执行的分析，并给出一套不改变业务逻辑的重构方案，重点回答以下问题：

1. 哪些目录是真的违反了当前架构与 `typescript-project-specifications` 的代码组织规范。
2. 哪些目录虽然没有 `index.ts`，但本质上不是“标准业务模块”，因此不应机械整改。
3. 对确认存在问题的目录，应如何在不影响启动链路、重建链路、主循环链路和退出清理链路语义的前提下完成重构。

本文档只讨论模块边界与目录组织，不修改交易业务规则，不引入兼容壳，不保留双轨路径。

---

## 2. 结论摘要

结论先行：

1. 当前确实存在结构失衡问题，但问题不是“所有没有 `index.ts` 的目录都错了”。
2. 真正需要整改的核心目录只有两类：
   1. `src/services/cleanup`
   2. `src/services/indicators` 与 `src/services/monitorContext` 之间的指标领域边界
3. 其中 `cleanup` 是 `src/app` 重构后的残留模块；`monitorContext` 残留职责与 `indicators` 实际属于同一指标领域，但当前被拆在两个顶级目录中，形成语义割裂。
4. `src/core`、`src/main`、`src/utils`、`src/types`、`src/app/runtime`、`src/main/lifecycle/cacheDomains`、`src/main/asyncProgram/monitorTaskProcessor/helpers` 等目录，虽然没有 `index.ts`，但它们不应被当作“标准业务模块”处理，不能机械补文件。

因此，正确方案不是“给每个目录补齐 `index.ts/types.ts/utils.ts`”，而是：

1. 先定义目录分类。
2. 只对真正的叶子业务模块执行规范化。
3. 删除已经失去真实职责的残留模块。
4. 将同一指标领域下的“画像编译”和“运行时计算”统一收口到同一父级领域目录。
5. 给仍然承担稳定公共职责的叶子模块建立明确入口。

---

## 3. 全链路现状分析

## 3.1 顶层启动与运行时装配链

当前顶层入口已经被收口到：

1. `src/index.ts`
2. `src/app/runApp.ts`

`runApp()` 当前承担的主链路顺序为：

1. 创建 pre-gate runtime
2. 创建 post-gate runtime
3. 执行 startup snapshot load
4. 收集 runtime symbol validation 输入并校验
5. 创建全部 monitor contexts
6. 创建 `rebuildTradingDayState`
7. 执行初次重建或进入 `startupRebuildPending` 恢复分支
8. 注册 delayed signal handlers
9. 创建 async runtime
10. 创建 lifecycle runtime
11. 创建 cleanup
12. 启动异步处理器
13. 进入 `mainProgram` 无限循环

这条主链已经符合 `app` 作为 composition layer 的目标，没有问题。本次目录规范化不能改变这条顺序，也不能把运行时能力重新塞回 `app` 之外的错误目录。

## 3.2 `cleanup` 链路现状

当前退出清理链路为：

1. `src/app/createCleanup.ts` 创建 cleanup controller
2. `src/services/cleanup/utils.ts` 提供 `releaseAllMonitorSnapshots()`
3. 该函数内部会调用 `releaseSnapshotObjects()`，并将 `monitorState.lastMonitorSnapshot` 置空

这说明：

1. `cleanup` 的对外装配职责已经迁入 `app`
2. 原 `src/services/cleanup/index.ts` 已被迁走
3. 原 `src/services/cleanup/types.ts` 已被删除
4. 目录下仅剩一个被 `createCleanup.ts` 单向调用的辅助函数

因此 `src/services/cleanup` 已不再是一个稳定 service 模块，而只是 app cleanup 组装实现的残留落点。

## 3.3 `monitorContext` 链路现状

当前 monitor context 装配链路为：

1. `src/app/createMonitorContexts.ts` 批量创建上下文
2. `src/app/createMonitorContext.ts` 负责单个 monitor 的装配
3. `src/services/monitorContext/utils.ts` 提供 `compileIndicatorUsageProfile()`

其中关键现状是：

1. 原 `src/services/monitorContext/index.ts` 已迁入 `src/app/createMonitorContext.ts`
2. 原 `src/services/monitorContext/types.ts` 已删除
3. 目录下仅剩 `utils.ts`
4. `utils.ts` 中还定义了局部类型 `IndicatorCollector`

这说明：

1. `monitorContext` 作为“上下文装配模块”的职责已经离开 `services`
2. 现在残留在该目录下的真实职责并不是 monitor context 组装，而是“指标画像编译”
3. 该职责与 `src/services/indicators` 同属指标领域，只是处于“配置编译阶段”
4. 目录名与真实职责已经失配
5. `types` 放在 `utils.ts` 内也继续违反了类型组织规则

## 3.4 `indicators` 链路现状

当前指标链路为：

1. `src/main/processMonitor/indicatorPipeline.ts` 使用 `buildIndicatorSnapshot()` 与 `getCandleFingerprint()`
2. 这两个公共入口目前定义在 `src/services/indicators/snapshotBuilder.ts`
3. `src/services/indicators` 同时包含 `adx.ts`、`ema.ts`、`kdj.ts`、`macd.ts`、`mfi.ts`、`psy.ts`、`rsi.ts`、`types.ts`、`utils.ts`

这说明：

1. `indicators` 实际上承载的是“指标运行时计算”能力
2. 而“指标需求编译”能力被散落在 `monitorContext/utils.ts`
3. 两者共享同一领域概念 `IndicatorUsageProfile`
4. 生产代码当前直接依赖 `snapshotBuilder.ts` 这类内部实现文件

因此它的问题不只是“缺少入口”，而是“同一领域被拆成两个顶级模块，其中一部分还挂在错误目录下”。

---

## 4. 目录分类模型

为了避免机械整改，必须先区分目录类型。

## 4.1 标准叶子模块

定义：

1. 目录本身承担一个稳定、可命名的业务或能力职责
2. 上层调用方应通过该目录的公共入口使用其能力
3. 目录内允许存在多个实现文件，但对外应有明确主入口

规则：

1. `index.ts` 必须存在
2. 若存在本地类型，使用 `types.ts`
3. 若存在纯工具函数，使用 `utils.ts`
4. 不允许只剩 `utils.ts` 却没有真实模块入口

示例：

1. `src/services/autoSymbolManager`
2. `src/services/marketMonitor`
3. `src/core/strategy`
4. `src/core/trader/orderExecutor`

## 4.2 父级共享目录

定义：

1. 目录本身不代表单一模块
2. 主要作用是承载多个子模块的最近共同父级共享文件
3. 该目录的 `types.ts` / `utils.ts` 面向子模块复用，而不是面向外部“作为一个模块”暴露

规则：

1. 不要求 `index.ts`
2. 允许只存在 `types.ts` 或 `utils.ts`
3. 不应被机械视为“缺少入口文件的异常模块”

示例：

1. `src/core`
2. `src/main`
3. `src/main/asyncProgram`
4. `src/utils`

## 4.3 领域父级目录

定义：

1. 目录本身代表一个稳定领域，而不是单一叶子模块
2. 目录的直接子项应是按职责拆分的叶子子模块
3. 目录自身不应继续承载叶子模块实现文件

规则：

1. 不要求 `index.ts`
2. 应以子模块目录为主，而不是以平级实现文件为主
3. 允许作为结构校验中的显式分类，不应误判为“缺少入口的叶子模块”
4. 若目录已经承担“领域父级目录”职责，则不应再同时兼任某个叶子模块的实现落点

示例：

1. `src/services/indicators`（本次重构后的目标形态）

## 4.4 内部实现命名空间目录

定义：

1. 目录只是某个上层模块的实现拆分区域
2. 文件之间是内部协作关系，不承担独立公共入口职责
3. 调用方通常只应使用上层拥有者模块，而不是依赖该目录作为一个独立模块

规则：

1. 不要求 `index.ts`
2. 可以包含若干实现文件
3. 命名上应清楚表达其为内部实现区域

示例：

1. `src/main/lifecycle/cacheDomains`
2. `src/main/asyncProgram/monitorTaskProcessor/handlers`
3. `src/main/asyncProgram/monitorTaskProcessor/helpers`
4. `src/app/runtime`

## 4.5 文件集合目录

定义：

1. 目录本身用于按主题聚合平级文件
2. 目录中每个文件都是独立文件模块
3. 目录本身不表示一个额外模块

示例：

1. `src/types`
2. `src/config`
3. `src/utils/asciiArt`

这类目录同样不应机械补 `index.ts`。

---

## 5. 对当前无 `index.ts` 目录的逐项判定

| 目录 | 分类 | 判定 | 处理 |
| --- | --- | --- | --- |
| `src/services/cleanup` | 标准叶子模块残留态 | 有问题 | 删除目录，职责回收 |
| `src/services/monitorContext` | 标准叶子模块残留态 | 有问题 | 删除目录，职责并入指标领域 |
| `src/services/indicators` | 领域父级目录候选 | 有问题 | 重构为领域父级目录，下设 `profile` 与 `runtime` |
| `src/core` | 父级共享目录 | 正常 | 保持不动 |
| `src/main` | 父级共享目录 | 正常 | 保持不动 |
| `src/main/asyncProgram` | 父级共享目录 | 正常 | 保持不动 |
| `src/app/runtime` | 内部实现命名空间目录 | 正常 | 保持不动 |
| `src/main/lifecycle/cacheDomains` | 内部实现命名空间目录 | 正常 | 保持不动 |
| `src/main/asyncProgram/monitorTaskProcessor/handlers` | 内部实现命名空间目录 | 正常 | 保持不动 |
| `src/main/asyncProgram/monitorTaskProcessor/helpers` | 内部实现命名空间目录 | 正常 | 保持不动 |
| `src/main/recovery` | 文件集合目录 | 正常 | 保持不动 |
| `src/main/startup` | 文件集合目录 | 正常 | 保持不动 |
| `src/types` | 文件集合目录 | 正常 | 保持不动 |
| `src/config` | 文件集合目录 | 正常 | 保持不动 |
| `src/utils/asciiArt` | 文件集合目录 | 正常 | 保持不动 |

这张表对应的关键判断是：

1. 真问题不是“没有 `index.ts`”本身
2. 真问题是“一个目录被当作稳定模块使用，但其公共入口已经消失或职责已经名不副实”
3. 对指标领域来说，真问题还包括“同一领域能力被拆成两个顶级目录，且其中一个目录名已经失真”

---

## 6. 根因分析

当前问题的根因有四个：

1. `src/app` 组装层重构只迁走了 `cleanup` 和 `monitorContext` 的主入口与类型，但没有同步处理旧目录的剩余辅助职责，形成残留模块。
2. 现有 lint 规则只校验 import 方向，没有校验“叶子模块入口完整性”与“只剩 utils 的残留目录”。
3. 现有代码组织规则被过度简化理解为“目录里应该有 types/utils”，但没有先区分“目录是否本身就是模块”。
4. 指标领域当前按“配置编译”和“运行时计算”被拆到 `monitorContext` 与 `indicators` 两个顶级目录，领域边界未统一。

因此，必须同时修两层问题：

1. 修正当前残留目录
2. 建立后续不会再次出现同类问题的结构规则

---

## 7. 是否应该统一还是分离

结论：

1. 应该统一到同一指标领域目录。
2. 但不应统一为同一个叶子模块。

原因如下。

### 7.1 为什么不应继续分离为两个顶级模块

如果继续保留顶级兄弟目录，例如：

1. `src/services/indicatorProfile`
2. `src/services/indicators`

会产生以下问题：

1. 两者都围绕 `IndicatorUsageProfile`、指标名称、周期集合、展示计划这组概念工作，领域边界高度重叠。
2. “画像编译”和“指标计算”在调用链上前后相接：先编译 profile，再按 profile 计算 snapshot。
3. 把它们拆成两个顶级模块，会制造两个近义命名空间，长期容易继续出现职责漂移。
4. 从维护视角看，开发者需要同时在两个顶级目录中寻找同一领域的代码，增加认知成本。

### 7.2 为什么又不能压成同一个叶子模块

如果把所有内容压平到一个 `src/services/indicators` 叶子模块中，会产生另一类问题：

1. `compileIndicatorUsageProfile()` 属于配置编译阶段能力，运行频率低，输入是 `signalConfig + verificationConfig`。
2. `buildIndicatorSnapshot()` 属于运行时计算阶段能力，运行频率高，输入是 `candles + indicatorProfile`。
3. 两者时序不同、依赖不同、职责不同。
4. 把两类能力塞到一个叶子模块的同一层，会让模块公共入口混杂“配置编译 API”和“运行时算法 API”，仍然不够清晰。

### 7.3 正确方案：统一为同一领域目录，内部按阶段分离

因此正确方案是：

1. 统一到 `src/services/indicators` 同一父级领域目录
2. 在该领域目录下再分成两个叶子子模块：
   1. `profile`
   2. `runtime`

这可以同时满足：

1. 领域统一
2. 运行阶段分离
3. 目录语义准确
4. 代码组织规范清晰

---

## 8. 重构目标

本次重构完成后，应满足以下目标：

1. `src/services/cleanup` 不再存在残留空壳目录。
2. `src/services/monitorContext` 不再承担与目录名不一致的职责。
3. 指标画像编译与指标运行时计算统一到同一指标领域目录。
4. `compileIndicatorUsageProfile()` 拥有语义正确、结构完整的稳定归属模块。
5. `src/services/indicators/profile` 与 `src/services/indicators/runtime` 都拥有明确入口。
6. 所有真实叶子模块都满足“入口明确、类型与工具归位、命名与职责一致”。
7. 父级共享目录与内部命名空间目录不被误判为异常目录。
8. 不引入兼容转发壳，不保留旧路径双轨。
9. 启动、重建、主循环、cleanup 行为保持不变。

---

## 9. 目标结构

目标结构如下：

```text
src/
├── app/
│   ├── createCleanup.ts
│   ├── createMonitorContext.ts
│   ├── createMonitorContexts.ts
│   ├── createLifecycleRuntime.ts
│   ├── rebuild.ts
│   ├── runApp.ts
│   ├── startupSnapshot.ts
│   ├── runtimeValidation.ts
│   ├── types.ts
│   └── runtime/
│       ├── createAsyncRuntime.ts
│       ├── createPostGateRuntime.ts
│       └── createPreGateRuntime.ts
├── services/
│   ├── indicators/
│   │   ├── profile/
│   │   │   ├── index.ts
│   │   │   ├── types.ts
│   │   │   └── utils.ts
│   │   └── runtime/
│   │       ├── index.ts
│   │       ├── types.ts
│   │       ├── utils.ts
│   │       ├── adx.ts
│   │       ├── ema.ts
│   │       ├── kdj.ts
│   │       ├── macd.ts
│   │       ├── mfi.ts
│   │       ├── psy.ts
│   │       └── rsi.ts
│   ├── autoSymbolFinder/
│   ├── autoSymbolManager/
│   ├── liquidationCooldown/
│   ├── marketMonitor/
│   ├── accountDisplay/
│   └── quoteClient/
```

明确要求：

1. 删除 `src/services/cleanup`
2. 删除 `src/services/monitorContext`
3. 将 `src/services/indicators` 规范化为父级领域目录
4. 新增 `src/services/indicators/profile`
5. 新增 `src/services/indicators/runtime`

---

## 10. 完整重构方案

## 10.1 阶段 0：先建立判定规则

在真正改代码之前，先固定本次方案的结构规则：

1. 只有“标准叶子模块”才要求 `index.ts`
2. 父级共享目录、内部实现命名空间目录、文件集合目录不强制要求 `index.ts`
3. 对标准叶子模块：
   1. `index.ts` 必须存在
   2. `types.ts` 仅在存在本地类型时存在
   3. `utils.ts` 仅在存在纯工具函数时存在
4. 不允许“目录只剩 `utils.ts`”
5. 不允许“目录名与真实职责不一致”
6. 不允许保留旧路径兼容壳

这一阶段不改业务逻辑，只固定后续所有迁移判断标准。

## 10.2 阶段 1：清理 `src/services/cleanup` 残留模块

### 现状

`src/services/cleanup` 只剩一个 `utils.ts`，其唯一调用方是 `src/app/createCleanup.ts`。

### 目标

将 `releaseAllMonitorSnapshots()` 回收到 app cleanup 模块内部，删除旧目录。

### 具体做法

1. 把 `releaseAllMonitorSnapshots()` 移入 `src/app/createCleanup.ts`
2. 该函数作为 `createCleanup.ts` 的模块内顶层私有函数存在
3. 删除 `src/services/cleanup/utils.ts`
4. 删除空目录 `src/services/cleanup`

### 原因

1. 该函数只服务于 app cleanup 组装链
2. 它不是跨模块复用的稳定 service
3. 继续留在 `services/cleanup` 下只会制造“模块仍然存在”的错觉

### 逻辑不变性

1. 清理步骤顺序不变
2. `releaseSnapshotObjects()` 调用不变
3. `lastMonitorSnapshot = null` 的副作用保持不变
4. 仅改变函数归属位置，不改变调用时机和入参/出参

## 10.3 阶段 2：将 `monitorContext` 残留职责并入 `indicators/profile`

### 现状

`src/services/monitorContext` 已不再承担 monitor context 装配职责，实际只剩“指标画像编译”。

### 目标

将该能力并入统一的指标领域目录 `src/services/indicators/profile`。

### 具体做法

1. 新建 `src/services/indicators/profile/index.ts`
   1. 放置 `compileIndicatorUsageProfile()` 公开入口
2. 新建 `src/services/indicators/profile/types.ts`
   1. 迁移 `IndicatorCollector` 等局部类型
3. 新建 `src/services/indicators/profile/utils.ts`
   1. 仅放置纯辅助函数，例如 `parseProfileIndicator()`、`buildDisplayPlan()`、周期解析与排序类 helper
4. 将 `appendUniqueIndicator()`、`collectIndicatorUsage()`、`compileVerificationIndicatorList()` 这类直接参与编译状态推进的 helper 保留在 `profile/index.ts` 或拆到语义准确的实现文件，不机械归入 `utils.ts`
5. 更新 `src/app/createMonitorContext.ts` 的 import，改为直接从新模块入口导入
6. 更新相关测试 import 与测试文件归属
7. 删除 `src/services/monitorContext/utils.ts`
8. 删除空目录 `src/services/monitorContext`

### 为什么不应作为顶级兄弟模块单独存在

1. 当前目录名已经表达“上下文组装”，但真实职责变成“指标画像编译”
2. 继续保留会让 `app/createMonitorContext.ts` 与 `services/monitorContext/utils.ts` 同时存在，边界长期混乱
3. 该能力未来更可能被 strategy、display、validation 等链路复用，因此应回到统一指标领域目录，而不是继续挂在 monitorContext 或单独裂变为新的顶级模块

### 逻辑不变性

1. `compileIndicatorUsageProfile()` 的输入仍然是 `signalConfig + verificationConfig`
2. 输出 `IndicatorUsageProfile` 结构保持不变
3. KDJ/MACD 家族展开规则保持不变
4. RSI/EMA/PSY 周期去重与排序保持不变
5. verification 支持集约束保持不变
6. `displayPlan` 生成顺序保持不变

## 10.4 阶段 3：将 `src/services/indicators` 重构为领域父级目录

### 现状

`src/services/indicators` 当前同时承担领域目录与运行时叶子模块两种身份，职责层级混杂。

### 目标

让 `src/services/indicators` 成为纯领域父级目录，并把运行时计算能力下沉为 `runtime` 子模块。

### 具体做法

1. 新建 `src/services/indicators/runtime/index.ts`
2. 将当前对外公共能力收口到 `runtime/index.ts`
   1. `getCandleFingerprint()`
   2. `buildIndicatorSnapshot()`
3. 将当前 `src/services/indicators/types.ts` 迁入 `runtime/types.ts`
4. 将当前 `src/services/indicators/utils.ts` 迁入 `runtime/utils.ts`
5. 将当前 `adx.ts`、`ema.ts`、`kdj.ts`、`macd.ts`、`mfi.ts`、`psy.ts`、`rsi.ts` 全部迁入 `runtime/`
6. 删除 `snapshotBuilder.ts`，其内容迁入 `runtime/index.ts`
7. 更新 `src/main/processMonitor/indicatorPipeline.ts` 和相关测试 import，改为直接依赖 `runtime/index.ts`

### 为什么不是简单在根目录补一个 `index.ts`

因为项目明确禁止 re-export。更重要的是，根目录现在更适合作为指标领域父级目录，而不是继续兼任运行时叶子模块。正确做法是把真正的公共入口实现移动到 `runtime/index.ts`，而不是在根目录做中间转发。

### 逻辑不变性

1. `buildIndicatorSnapshot()` 算法不变
2. 对 `calculateADX`、`calculateEMA`、`calculateKDJ`、`calculateMACD`、`calculateMFI`、`calculatePSY`、`calculateRSI` 的调用顺序与条件不变
3. `getCandleFingerprint()` 判定逻辑不变
4. 对象池记录的申请与释放逻辑不变

## 10.5 阶段 4：补齐结构校验，防止回归

现有 `eslint.config.js` 只覆盖了 import 方向，不覆盖模块入口完整性。

本阶段应新增自动化校验规则：

1. 检查“标准叶子模块”是否缺少 `index.ts`
2. 检查是否存在“目录只剩 `utils.ts`”
3. 检查是否存在“目录只剩 `types.ts` 且该目录本身又被当作叶子模块使用”
4. 检查是否存在“领域父级目录与叶子模块职责混写”

推荐实现方式：

1. 使用脚本扫描 `src/**`
2. 将目录按本文定义的五类进行白名单/规则化判定
   1. 标准叶子模块
   2. 父级共享目录
   3. 领域父级目录
   4. 内部实现命名空间目录
   5. 文件集合目录
3. 在 `bun lint` 或独立检查命令中接入

注意：

1. 不要对 `src/core`、`src/main`、`src/utils`、`src/types`、`src/app/runtime`、`src/main/lifecycle/cacheDomains` 这类目录报误报
2. 不要对已经声明为“领域父级目录”的 `src/services/indicators` 报“缺少 `index.ts`”误报
3. 规则必须建立在目录分类之上，而不是建立在“任何目录都必须有 `index.ts`”之上

---

## 11. 本方案明确不做的事情

为了保证重构边界收敛，本方案明确不做以下扩 scope 操作：

1. 不重写 `runApp()` 启动顺序
2. 不改动 `loadStartupSnapshot()` 和 `executeTradingDayOpenRebuild()` 的参数语义
3. 不重构 `main` 生命周期模块
4. 不重构 `autoSymbolManager`、`marketMonitor`、`quoteClient` 等已稳定模块
5. 不把 `src/app` 全面改成“每个文件一个子目录”
6. 不给 `src/types`、`src/config`、`src/utils/asciiArt` 这类文件集合目录强行补 `index.ts`
7. 不引入兼容性转发文件

---

## 12. 迁移顺序与验证要求

推荐迁移顺序如下：

1. 先迁移 `cleanup`
2. 再迁移 `monitorContext` 残留职责到 `indicators/profile`
3. 再迁移 `indicators` 运行时能力到 `indicators/runtime`
4. 最后接入自动化校验

这样安排的原因是：

1. `cleanup` 最简单，风险最低
2. `indicators/profile` 是领域统一与类型归位，影响面适中
3. `indicators/runtime` 收口会影响生产代码和测试 import，适合放在前两步稳定后执行
4. 自动化规则应在结构稳定后再落地，避免先加规则阻断迁移过程

每个阶段完成后都必须执行：

1. `bun lint`
2. `bun type-check`
3. 受影响测试

至少应覆盖：

1. `tests/app/createCleanup.business.test.ts`
2. `tests/app/createMonitorContext.business.test.ts`
3. `tests/services/indicators/profile/index.business.test.ts`
4. `tests/main/processMonitor/indicatorPipeline.business.test.ts`
5. `tests/services/indicators/runtime/index.business.test.ts`
6. `tests/services/marketMonitor/business.test.ts`

测试迁移映射必须与 `src/` 结构同步，至少包含：

1. `tests/utils/signalConfigParser.business.test.ts` -> `tests/services/indicators/profile/index.business.test.ts`
2. `tests/services/indicators/business.test.ts` -> `tests/services/indicators/runtime/index.business.test.ts`
3. `tests/main/processMonitor/indicatorPipeline.business.test.ts` 保持在原目录，仅更新 import 路径
4. `tests/app/createMonitorContext.business.test.ts` 保持在原目录，仅更新 import 路径

---

## 13. 验收标准

完成后应满足以下标准：

1. `src/services/cleanup` 已删除
2. `src/services/monitorContext` 已删除
3. `src/services/indicators/profile/index.ts`、`types.ts`、`utils.ts` 已建立
4. `src/services/indicators/runtime/index.ts`、`types.ts`、`utils.ts` 已建立
5. `compileIndicatorUsageProfile()` 已迁入 `src/services/indicators/profile`
6. `releaseAllMonitorSnapshots()` 不再位于 `services/cleanup`
7. 生产代码不再直接从 `src/services/indicators/snapshotBuilder.ts` 导入
8. `src/services/indicators` 不再同时兼任领域父级目录与运行时叶子模块
9. 没有新增 re-export
10. 没有新增兼容壳
11. 测试目录已按新的 `src/services/indicators/profile` 与 `src/services/indicators/runtime` 结构完成对应迁移
12. `profile/utils.ts` 仅承载纯辅助函数，未错误吸收流程编译逻辑
13. `bun lint` 通过
14. `bun type-check` 通过
15. 受影响测试全部通过
16. 启动、初次重建、开盘重建、主循环、退出清理行为无回归

---

## 14. 最终结论

本次问题的本质不是“目录里少了文件”，而是：

1. 新架构迁移后留下了一处 cleanup 残留模块
2. 指标领域被拆成了 monitorContext 残留能力与 indicators 运行时能力两个顶级目录
3. `indicators` 根目录同时兼任领域父级与叶子模块，结构层级不清

因此，正确的大局方案是：

1. 删除已失去真实职责的 `src/services/cleanup`
2. 将 `src/services/monitorContext` 的残留能力并入统一的 `src/services/indicators/profile`
3. 将当前指标计算实现收口到 `src/services/indicators/runtime`
4. 让 `src/services/indicators` 成为真正的领域父级目录
5. 保持父级共享目录、内部命名空间目录和文件集合目录不被误判
6. 补齐自动化结构校验，阻止后续再次出现“只剩 utils 的残留目录”以及“领域父级与叶子模块混写”

这是一套符合当前总体架构方向、符合代码组织规范、不会改变原有业务逻辑的系统性重构方案。

# 系统性规范收尾项说明：`logger` 依赖注入与局部类型迁移

## 1. 文档目的

本文件用于详细说明本轮审查后仍然保留、但没有在当前修复回合直接落地的两项系统性整理工作：

1. 将全仓大量直接依赖全局 `logger` 单例的模块，系统性改造为显式依赖注入。
2. 将仍然散落在非 `types.ts` 文件中的局部类型定义，系统性迁移到对应的 `types.ts`。

这两项都不是“单点修补”问题，而是横跨多个目录、多个依赖边界、多个测试面的结构性整理。当前代码已经恢复为绿色状态，但如果目标是继续向“规范完全收敛”推进，这两项就是下一批应被正式规划的工作。

---

## 2. 为什么这两项没有在本轮直接执行

本轮已经完成的修复以“确定存在、证据闭合、且可以低风险直接验证”的问题为主，典型包括：

1. 末日保护在未真实提交时错误清缓存。
2. 对象池信号在去重/异常路径未释放。
3. 卖出成交后未按 `relatedBuyOrderIds` 精确扣账。
4. 本地买单 ID 同毫秒冲突。
5. 启动恢复阶段提前创建 `QuoteContext`。
6. 若干私有 helper 导出、多余导出与死代码。

这些问题都有共同特征：

1. 影响真实业务正确性或运行稳定性。
2. 修改面相对集中。
3. 可通过现有测试或新增小范围测试快速闭环验证。

而本文讨论的两项不同：

1. 它们大多不是当前线上行为 bug，而是架构/规范层面的持续性偏离。
2. 一旦开始改，会牵动大量模块签名、工厂依赖、测试替身、调用链和目录组织。
3. 若在没有完整方案的情况下边改边推，很容易把这轮已经收敛的绿色状态重新打散。

因此，本轮选择的策略是：

1. 先修复功能与稳定性问题。
2. 先把 `lint`、`type-check`、`ts-prune`、`knip` 和全量测试收敛到绿色。
3. 再把这两项作为下一批系统性整理的正式计划列出来。

---

## 3. 收尾项一：全局 `logger` 单例改为依赖注入

## 3.1 当前问题是什么

当前仓库中仍然存在大量模块直接写死：

```ts
import { logger } from '../../utils/logger/index.js';
```

这意味着模块在编译期就绑定了一个全局日志实现，而不是通过工厂参数或依赖对象显式注入。

本轮复核时，对 `src/app`、`src/main`、`src/core`、`src/services` 做了检索，命中范围远大于最初子代理抽样看到的 5 个文件，实际分布已经覆盖多个层级，包括但不限于：

1. `src/services/accountDisplay/index.ts`
2. `src/services/quoteClient/index.ts`
3. `src/services/marketMonitor/index.ts`
4. `src/services/autoSymbolManager/index.ts`
5. `src/services/indicators/utils.ts`
6. `src/core/orderRecorder/index.ts`
7. `src/core/orderRecorder/orderStorage.ts`
8. `src/core/trader/orderExecutor/index.ts`
9. `src/core/trader/orderMonitor/*`
10. `src/core/riskController/*`
11. `src/core/doomsdayProtection/index.ts`
12. `src/main/mainProgram/index.ts`
13. `src/main/processMonitor/*`
14. `src/main/asyncProgram/*`
15. `src/main/lifecycle/*`
16. `src/app/*`

这说明问题已经不是“某几个 service 不够纯”，而是：

1. 日志单例已经成为横穿全仓的隐式基础设施依赖。
2. 很多工厂虽然名义上在做依赖注入，但日志仍然绕过工厂参数直接从模块级单例取得。

---

## 3.2 为什么这是规范问题

根据仓库当前 `typescript-project-specifications`，硬性要求是：

1. 所有依赖通过参数注入。
2. 永远不在内部创建。

全局 `logger` 单例虽然不是“现场 new 出来”的对象，但本质上仍然是隐藏依赖：

1. 调用方无法从类型签名看出该模块依赖日志。
2. 测试只能通过 `mock.module` 或全局猴子补丁控制日志行为，而不是通过局部注入替身。
3. 模块边界图会失真，阅读函数签名时看不到完整依赖。
4. 工厂函数的“输入即依赖”原则被破坏。

这类问题短期不一定导致 bug，但长期会持续放大三个维护成本：

1. 测试成本：模块测试要么忍受真实日志输出，要么使用模块级 mock。
2. 重构成本：日志实现一旦想分层、分域或切换接口，改动会蔓延到整个 import 图。
3. 边界成本：模块名义上是纯函数/工厂，实际上仍然偷偷使用环境级单例。

---

## 3.3 为什么不能“看到一个改一个”

这项工作不能零碎推进，原因是它不是“替换 import”那么简单。

以一个典型工厂为例，如果把：

```ts
import { logger } from '../../utils/logger/index.js';
```

改为：

```ts
createXxx({ ..., logger })
```

后面通常会连锁触发：

1. `types.ts` 里要新增或收紧依赖类型。
2. 所有生产调用点都要补传 `logger`。
3. 所有测试替身和工厂测试都要同步补传 `logger`。
4. 如果下游 helper 也直接 import 了 logger，还得继续往下打通。
5. 某些目录会出现“上层显式传，底层又继续偷偷 import”的过渡态，需要继续清到底。

如果不一次性把某个子域清完，就会出现混合态：

1. 一部分模块用注入日志。
2. 一部分模块仍用全局单例。
3. 调用链中同一条日志路径同时混用两套来源。

这种状态比“暂时不改”更差，因为它既不纯，也更难理解。

---

## 3.4 这项工作的正确目标

正确目标不是“把所有文件都传一个 `logger` 参数”，而是建立稳定的日志注入边界。

建议按三层原则处理：

### A. 顶层装配层

例如：

1. `src/index.ts`
2. `src/app/runApp.ts`
3. `src/app/runtime/*`

这层允许持有真实 `logger` 实现，并把它注入到下层。

### B. 工厂边界层

例如：

1. `createMarketDataClient`
2. `createOrderRecorder`
3. `createOrderMonitor`
4. `createAutoSymbolManager`
5. `createDoomsdayProtection`
6. `createMonitorTaskProcessor`

这层要把日志依赖写进依赖对象类型里，作为显式输入。

### C. 纯工具/纯算法层

例如：

1. 真正纯粹的 `utils.ts`
2. 只做计算和格式化的 helper

这层原则上不应该依赖日志；如果当前依赖日志，多半说明它不是纯工具，应该上移到更合适的工厂模块，或把日志行为回收到调用方。

---

## 3.5 建议的实施顺序

这项整理必须分域推进，而不是全仓一次性横扫。

推荐顺序：

1. `src/app` 与 `src/main/lifecycle`
2. `src/main/asyncProgram` 与 `src/main/processMonitor`
3. `src/core/trader` 与 `src/core/orderRecorder`
4. `src/core/riskController`、`src/core/doomsdayProtection`、`src/core/signalProcessor`
5. `src/services/*`

原因：

1. `app` 和 `main` 本来就是装配与编排边界，最适合先建立“注入从何而来”的规则。
2. `core` 和 `services` 更适合作为被注入方，放在第二阶段收口。
3. 先把顶层边界建好，后面下沉替换时不会来回返工。

---

## 3.6 每一阶段的验收标准

每清完一个子域，至少要满足：

1. 该子域不再直接 import 全局 `logger` 单例。
2. 日志依赖全部出现在对应工厂参数或显式 deps 类型中。
3. 测试替身不再依赖 `mock.module` 才能抑制日志。
4. `bun run lint` 通过。
5. `bun run type-check` 通过。
6. 该子域相关测试通过。

更严格的做法是把这条规则接入 lint：

1. 对选定目录设置 `no-restricted-imports`，禁止直接导入 `utils/logger/index.js`。
2. 按目录逐步扩大禁令范围，而不是一口气全仓开启。

这样可以防止整理完一部分后又被新代码反向污染。

---

## 3.7 这项工作的真实改动成本

这项整理的成本主要不在实现本身，而在“签名扩散”和“测试面扩散”。

预期改动会包括：

1. 大量 `types.ts` 变更。
2. 大量工厂 deps 对象变更。
3. 大量测试替身补参。
4. 某些本来写成工具模块的文件需要重新定义边界。

因此，这项工作适合单独开一轮重构，而不适合在功能修复回合里夹带推进。

---

## 4. 收尾项二：把局部类型定义迁移到 `types.ts`

## 4.1 当前问题是什么

仓库规范要求：

1. 类型定义必须放在 `types.ts`。
2. 共享类型进入公共 `types.ts`。

本轮再次扫描后，在排除 `types.ts`、`types/`、`utils.ts`、`utils/` 后，仍能看到多处真实类型定义散落在普通实现文件或测试文件里，典型包括：

### `mock/`

1. `mock/longport/tradeContextMock.ts`
2. `mock/longport/quoteContextMock.ts`
3. `mock/longport/eventBus.ts`

### `tests/`

1. `tests/integration/main-loop-latency.integration.test.ts`
2. `tests/main/processMonitor/index.business.test.ts`
3. `tests/main/processMonitor/indicatorPipeline.business.test.ts`
4. `tests/main/asyncProgram/orderMonitorWorker/business.test.ts`
5. `tests/services/autoSymbolManager/periodicSwitch.business.test.ts`

这些类型多数是局部辅助类型，不会直接影响运行逻辑，但它们构成了持续性的规范偏离。

---

## 4.2 为什么这不是“无所谓的小问题”

局部类型放在实现文件里，看起来只是方便，但长期会带来三类问题：

1. 类型入口分散。
2. 文件职责混合。
3. 迁移成本滚雪球。

### A. 类型入口分散

维护者阅读模块时，不知道类型应该去哪里找：

1. 有的在 `types.ts`
2. 有的在实现文件顶部
3. 有的在测试文件中部

这会直接破坏仓库已经建立的约定。

### B. 文件职责混合

当实现文件同时承担：

1. 运行逻辑
2. 局部类型建模
3. 测试辅助结构声明

文件会越来越像“可执行代码 + 类型杂糅容器”，后续重构时很难拆。

### C. 迁移成本滚雪球

现在很多散落类型是局部类型，似乎影响不大；但如果长期不整理，会出现：

1. 新代码继续照着旧例子内联定义类型。
2. 局部类型慢慢被多处引用，最后变成“事实共享类型”。
3. 真到要整理时，改动面比现在大得多。

所以这项工作虽然优先级低于功能 bug，但不是可永久搁置的“纯风格问题”。

---

## 4.3 为什么也不能机械搬迁

这项工作同样不能机械做成“发现一个 type 就搬一个”。

因为每个散落类型需要先判断它属于哪一类：

1. 只在单文件内部使用的局部类型。
2. 同目录多个文件会复用的共享类型。
3. 本来就不该存在的临时测试类型。

不同类别处理方式不同：

### A. 单文件局部类型

应迁到同目录 `types.ts`，再 `import type` 回来。

### B. 同目录共享类型

应直接放进该子域已有 `types.ts`，作为正式边界类型。

### C. 临时测试类型

若只是为了让单个用例更易读，需要先判断是否值得存在：

1. 值得存在，则迁到测试侧 `types.ts`
2. 不值得存在，则直接删掉并内联最小对象字面量

也就是说，这项整理不是纯搬家，而是一次类型边界梳理。

---

## 4.4 当前扫描结果说明了什么

当前剩余命中主要集中在两类：

1. `mock/longport/*`
2. `tests/*`

这说明生产代码主干已经比测试侧更接近规范，而下一批整理重点应放在：

1. mock 基础设施
2. 测试用例局部辅助类型

这是一件好事，因为它意味着：

1. 生产逻辑的风险较低。
2. 可以先从低风险目录开始把规范清干净。

但也有一个边界需要注意：

1. 测试代码同样受当前 TypeScript 规范约束。
2. 不能因为它们在 `tests/` 下，就默认允许持续偏离。

---

## 4.5 建议的实施顺序

推荐按下面顺序推进：

1. `mock/longport/*`
2. `tests/app/*`
3. `tests/main/*`
4. `tests/services/*`
5. `tests/integration/*`

原因：

1. `mock/longport` 是一组相对独立的基础设施 mock，迁移后收益高、外部影响可控。
2. `tests/app`、`tests/main` 更靠近当前架构边界，适合先统一。
3. `integration` 最后处理，因为它们往往含有更多一次性场景描述类型。

---

## 4.6 每一阶段的验收标准

每整理完一个目录，至少要满足：

1. 该目录内不再在非 `types.ts` 文件定义 `type/interface`。
2. 新增的 `types.ts` 注释符合 `CLAUDE.md`。
3. 所有使用处改成顶部 `import type`。
4. 不引入 re-export。
5. `bun run lint` 通过。
6. `bun run type-check` 通过。
7. 目录相关测试通过。

同样建议把这条规则自动化：

1. 用 lint 或自定义脚本限制指定目录中非 `types.ts` 的 `type/interface` 声明。
2. 先在 `mock/` 和 `tests/` 小范围启用，再逐步扩大。

---

## 4.7 这项工作的真实改动成本

这项整理的实现风险不高，但机械劳动量不小，主要包括：

1. 拆出新 `types.ts`
2. 调整 import
3. 维护注释
4. 避免和现有 `types.ts` 命名冲突

它的好处是：

1. 风险低于 logger 注入重构。
2. 更适合作为一个独立的“规范清扫批次”执行。

因此，这项工作可以早于 logger 注入，也可以作为 logger 注入前的铺垫批次。

---

## 5. 两项工作的优先级比较

如果只能先做一项，建议优先级如下：

1. `logger` 依赖注入
2. 局部类型迁移到 `types.ts`

原因：

1. `logger` 注入影响的是长期架构边界与测试控制能力。
2. 局部类型迁移主要影响的是代码组织一致性。

但从落地难度看，顺序可以反过来：

1. 先清理局部类型迁移，作为低风险规范批次。
2. 再启动 logger 注入的系统性重构。

这两种顺序都成立，取决于下一轮的目标是：

1. 先拿更多“规范完成度”
2. 还是先修更核心的边界设计问题

---

## 6. 建议的后续执行方案

如果下一轮要继续推进“规范收敛为零”，建议拆成两张独立任务，不要混做：

### 任务 A：测试与 mock 层类型组织收敛

目标：

1. 清理 `mock/`、`tests/` 中所有非 `types.ts` 的局部类型定义。
2. 建立目录级 `types.ts` 单一入口。
3. 对测试目录增加自动校验。

特点：

1. 风险低。
2. 范围清晰。
3. 适合作为先手。

### 任务 B：日志依赖注入系统性重构

目标：

1. 建立日志依赖注入边界。
2. 逐域移除对全局 `logger` 单例的直接 import。
3. 对目标目录增加 `no-restricted-imports`。

特点：

1. 风险高于任务 A。
2. 需要更强的阶段规划和更细的测试回归。
3. 更接近真正的架构性收尾。

---

## 7. 最终结论

本轮没有继续直接执行这两项，不是因为它们不重要，而是因为它们都已经进入“需要单独立项”的阶段。

结论如下：

1. `logger` 单例直连问题真实存在，而且规模比最初抽样看到的更大，已经是全仓级隐式依赖问题。
2. 非 `types.ts` 的局部类型定义也真实存在，当前主要集中在 `mock/` 和 `tests/`，适合作为下一批低风险规范整理。
3. 两项都值得做，但都不适合夹带在功能缺陷修复回合里零散推进。
4. 若下一轮继续追求“规范完全收敛”，应将它们拆成独立任务并分别验收，而不是混在同一次修改里。

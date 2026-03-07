# 自动寻标距离单位错配二次验证与系统性修复方案（2026-03-07）

## 1. 文档目标

本文档用于在已完成首轮排查的基础上，对 `bun dev` 中自动寻标“主条件与降级条件均未命中”的问题进行二次分析和验证，并给出一个**系统性且完整性**的修复方案。

本方案明确要求：

1. 不采用兼容性补丁，不保留双单位并存的运行时逻辑。
2. 不只修单点筛选函数，而是统一自动寻标全链路的距离单位语义。
3. 不将 `utils/getWarrants.js` 纳入修复范围；该文件是测试工具，不作为生产代码整改对象。

## 2. 二次验证范围与方法

## 2.1 验证范围

本次二次验证覆盖以下链路：

1. 配置解析链路：
   - `src/config/config.trading.ts`
   - `src/config/config.validator.ts`
2. 自动寻标主链路：
   - `src/services/autoSymbolFinder/*`
   - `src/services/autoSymbolManager/thresholdResolver.ts`
   - `src/services/autoSymbolManager/autoSearch.ts`
   - `src/main/startup/seat.ts`
3. 距回收价换标链路：
   - `src/services/autoSymbolManager/switchStateMachine.ts`
   - `src/core/riskController/warrantRiskChecker.ts`
4. 配套说明与测试基线：
   - `README.md`
   - `tests/services/autoSymbolFinder/*`
   - `tests/main/startup/seat.business.test.ts`
   - `tests/integration/auto-search-policy-consistency.integration.test.ts`
   - 其他依赖自动寻标距离口径的测试文件

## 2.2 二次验证方法

本次验证采用三层交叉方法：

1. 静态代码阅读：
   - 逐层检查配置解析、策略构造、候选筛选、换标比较的单位语义。
2. 运行时实测：
   - 执行 `bun utils/getWarrants.js HSI.HK bull`
   - 执行 `bun utils/getWarrants.js HSI.HK bear`
   - 执行 `bun utils/getWarrants.js 9988.HK bull`
   - 执行 `bun utils/getWarrants.js 9988.HK bear`
   - 使用临时脚本直接调用 `QuoteContext.warrantList`，按主程序当前配置分别统计：
     - 原始比较结果
     - 阈值归一化后的比较结果
3. 影响面复核：
   - 对比自动寻标与风险检查/换标链路的距离百分比计算方式。
   - 对比生产代码与测试用例的 `distancePct` 单位假设。

## 3. 二次验证结论

## 3.1 结论一：根因已确认，是自动寻标链路的距离单位错配

问题根因不是交易分钟数，不是成交额过滤，也不是席位状态机。

根因是：

1. 配置与风险控制链路使用的是“百分比值”口径。
   - 例如 `1.85` 表示 `1.85%`
   - 例如 `0.35` 表示 `0.35%`
2. `warrantList.toCallPrice` 的真实运行时值是“小数比值”口径。
   - 例如 `0.0221146825` 表示 `2.21146825%`
3. 自动寻标直接拿 `toCallPrice` 原始值与配置阈值比较，没有做单位归一化。

于是，主程序当前实际执行的是：

- 牛证：`0.0221 > 1.85`，结果为 `false`
- 熊证：`-0.0206 < -1.85`，结果为 `false`

所以日志中 `primaryCandidates=0`、`degradedCandidates=0` 是必然结果。

## 3.2 结论二：当前自动寻标日志与真实 API 数据完全一致

复核结果如下：

| 场景           | 列表条数 | 使用当前主程序原始比较   | 将阈值归一化到 API 小数口径后 |
| -------------- | -------: | ------------------------ | ----------------------------- |
| `HSI.HK bull`  |     1581 | `primary=0 / degraded=0` | `primary=35 / degraded=0`     |
| `HSI.HK bear`  |      966 | `primary=0 / degraded=0` | `primary=21 / degraded=16`    |
| `9988.HK bull` |       73 | `primary=0 / degraded=0` | `primary=17 / degraded=0`     |
| `9988.HK bear` |       95 | `primary=0 / degraded=0` | `primary=3 / degraded=0`      |

这说明：

1. 主程序日志不是误报。
2. 候选确实存在。
3. 候选被 100 倍单位错配全部过滤掉了。

## 3.3 结论三：风险检查与换标链路的内部语义并不错误，错误集中在自动寻标边界

`src/core/riskController/warrantRiskChecker.ts` 中距回收价百分比的计算是：

```ts
((当前价 - 回收价) / 回收价) * 100;
```

这意味着风险检查和 `riskChecker.getWarrantDistanceInfo()` 返回的 `distanceToStrikePercent` 已经是“百分比值”口径。

`switchStateMachine.ts` 中距回收价换标判断拿到的是 `riskChecker` 返回值，再与 `switchDistanceRange` 比较，因此它在运行时比较上是自洽的。

真正的断点在于：

1. 风险检查链路把距离值转成了百分比值。
2. 自动寻标链路没有转换，直接吃了 `warrantList.toCallPrice` 原始小数值。

## 3.4 结论四：测试基线本身也固化了错误假设

当前自动寻标相关测试大量直接用：

- `0.35`
- `0.6`
- `-0.3499`

作为 `warrantList.toCallPrice` 的 mock 值。

这意味着测试把“配置阈值单位”和“候选 API 字段单位”人为设成了一致口径，无法暴露真实 API 的单位差异。

因此当前测试通过，不代表生产链路正确。

## 3.5 结论五：`getWarrants.js` 不能作为与主程序完全等价的对照工具

二次验证还发现：

1. `utils/getWarrants.js` 使用了硬编码枚举值。
2. 它的查询参数与主程序并不完全一致。
3. 对 `9988.HK`，脚本和主程序返回的列表条数已经不相同。

因此：

1. 该脚本可以用于观察 API 字段。
2. 但不能继续作为“主程序筛选结果必然等价”的证明工具。

根据本次任务要求，`utils/getWarrants.js` 不纳入修复范围，只作为验证背景保留。

## 4. 问题矩阵（基于二次验证）

## 4.1 严重问题（必须修复）

1. 自动寻标候选筛选比较使用了错误单位。
2. 启动寻标、运行时自动寻标、换标预寻标共用同一错误边界。
3. 自动寻标相关测试无法覆盖真实 API 单位口径。

## 4.2 重要问题（应该同步修复）

1. 自动寻标模块的类型注释与真实外部数据单位不够明确。
2. README 当前对“内部运行时单位”和“外部 API 原始单位”的区分不清晰。
3. 历史设计文档中关于 `warrantList.toCallPrice` 运行时单位的前提存在错误，后续排查容易被误导。

## 4.3 非本次修复范围

1. `utils/getWarrants.js` 的参数和枚举写法。
2. 历史 `docs/plans/*` 作为存档文档的回写修订。
3. 任何与自动寻标距离单位无关的交易或订单逻辑调整。

## 5. 系统性修复目标

本次修复必须达到以下目标：

1. 明确建立**唯一内部运行时单位**。
2. 在生产边界统一完成单位归一化，不允许比较逻辑自行猜测单位。
3. 自动寻标三条入口使用同一套距离语义和同一套策略对象。
4. 风险检查、换标判断、自动寻标、日志展示、测试数据全部围绕同一运行时单位组织。
5. 删除错误的测试前提，新增真实 API 口径测试。

## 6. 总体设计决策

## 6.1 单位语义唯一化

本次修复必须确定一个唯一内部运行时单位。

建议采用：

- **内部运行时统一使用“百分比值”**
- 即：
  - `0.35` 表示 `0.35%`
  - `1.85` 表示 `1.85%`
  - `-3.5` 表示 `-3.5%`

原因：

1. 当前配置、风险常量、换标区间、README 都是围绕这一语义编写的。
2. `warrantRiskChecker` 已按该语义返回 `distanceToStrikePercent`。
3. 主程序除自动寻标外，其余距离业务链路基本都在该语义下工作。

因此，不应把整个系统改成“小数比值口径”，而应在 `warrantList` 边界把外部原始值统一转换为内部百分比值。

## 6.2 外部边界与内部边界分离

必须明确分离两类概念：

1. 外部 API 原始单位
   - `warrantList.toCallPrice`
   - 真实值为小数比值
   - `0.0221` 表示 `2.21%`
2. 内部运行时单位
   - 自动寻标策略阈值
   - 换标区间
   - 日志输出中的 `distancePct`
   - `WarrantCandidate.distancePct`
   - 风险检查中的距离百分比
   - 统一为百分比值

这个边界必须在自动寻标模块入口显式实现，不能继续分散在调用点猜测。

## 6.3 不允许双单位兼容运行

本次修复不能采用如下做法：

1. “如果值小于 1 就乘 100，否则不乘”的隐式兼容逻辑。
2. 在不同调用方保留不同单位，再在比较前临时判断。
3. 在日志层和业务层使用不同的距离解释方式。

这些做法都会把当前错误长期保留下来，只是换一种形式隐藏。

## 7. 详细修复方案

## 7.1 修复一：在自动寻标边界建立显式的距离归一化函数

需要在 `src/services/autoSymbolFinder` 内建立唯一的外部距离归一化入口，职责是：

1. 读取 `warrantList.toCallPrice`
2. 将其从 API 原始小数比值转换为内部百分比值
3. 后续所有自动寻标比较、排序、日志、返回结果都只消费转换后的值

建议要求：

1. 使用 `Decimal` 完成乘以 `100` 的转换。
2. 归一化后再进入 `resolveSelectionStage`、排序与日志。
3. `WarrantCandidate.distancePct` 明确约定为“百分比值”。

这样可以保证：

1. 自动寻标主条件与配置阈值同单位。
2. 自动寻标降级区间与换标区间同单位。
3. 自动寻标返回结果与风险检查展示同单位。

## 7.2 修复二：自动寻标类型定义与注释同步重写

需要同步修订以下类型/注释语义：

1. `src/services/autoSymbolFinder/types.ts`
2. `src/types/config.ts`
3. `src/config/config.trading.ts`
4. `src/config/config.validator.ts`
5. `README.md`

修订原则：

1. 明确 `warrantList.toCallPrice` 是“外部 API 原始小数比值”。
2. 明确 `DirectionalAutoSearchPolicy.primaryThreshold`、`degradedRange`、`switchDistanceRange` 是“内部百分比值”。
3. 明确 `WarrantCandidate.distancePct` 是“内部百分比值”。

## 7.3 修复三：保持三条寻标入口完全共用同一归一化结果

自动寻标三条入口必须共用同一套修复后的边界：

1. 启动空席位寻标：
   - `src/main/startup/seat.ts`
2. 运行时空席位自动寻标：
   - `src/services/autoSymbolManager/autoSearch.ts`
3. 距回收价换标预寻标：
   - `src/services/autoSymbolManager/switchStateMachine.ts`

这三条链路当前已经共用 `findBestWarrant`，因此正确的系统性做法是：

1. 只在 `autoSymbolFinder` 边界统一修正单位。
2. 不在三条调用链各自做局部换算。

## 7.4 修复四：测试基线整体切换到真实 API 原始单位

自动寻标相关测试必须整体升级，而不是只补几条新用例。

### 必须修改的测试类别

1. `tests/services/autoSymbolFinder/business.test.ts`
2. `tests/main/startup/seat.business.test.ts`
3. `tests/integration/auto-search-policy-consistency.integration.test.ts`
4. 其他通过 mock `warrantList.toCallPrice` 构造候选的测试

### 修改原则

1. 测试中模拟 `warrantList.toCallPrice` 时，必须使用真实 API 原始单位。
   - 例如：
     - `0.0036` 表示 `0.36%`
     - `0.0221` 表示 `2.21%`
2. 配置阈值、风险常量、换标区间依然使用内部百分比值。
3. 断言 `findBestWarrant` 返回的 `candidate.distancePct` 应为百分比值。

这一步是本次修复不可省略的核心部分，否则生产 bug 会在测试中继续被掩盖。

## 7.5 修复五：增加真实单位转换的专门测试

除修正旧测试外，必须新增专门的边界测试，验证“外部小数比值 -> 内部百分比值”的转换语义。

至少新增以下测试：

1. `0.0221146825` 应被解释为 `2.21146825%`
2. 牛证阈值 `1.85` 时：
   - `0.0184` 不命中主条件
   - `0.0185000001` 命中主条件
3. 熊证阈值 `-1.85` 时：
   - `-0.0184` 不命中主条件
   - `-0.0185000001` 命中主条件
4. 降级区间边界在真实 API 原始单位下仍保持开区间语义

## 7.6 修复六：README 与运行文档更新为“双边界说明”

README 需要补充以下信息：

1. 用户配置仍填写百分比值。
2. `warrantList.toCallPrice` 是外部原始小数比值。
3. 系统会在自动寻标边界将 API 原始值转换为内部百分比值后再参与筛选。

目的不是给用户增加负担，而是避免后续维护者再次误判单位。

## 7.7 修复七：历史错误前提只在 issue 文档中纠偏，不回写存档计划

`docs/plans/2026-03/2026-03-06-auto-symbol-distance-threshold-degrade-refactor-plan.md` 中关于 `warrantList.toCallPrice` 运行时口径的前提存在错误。

本次建议：

1. 不回写历史计划文档正文，保留其历史记录属性。
2. 在本 issue 文档中明确纠偏。
3. 在 README 和正式实现注释中写出最终正确语义。

## 8. 模块级改造清单

本次系统性修复落地时，至少需要覆盖以下模块：

1. `src/services/autoSymbolFinder/utils.ts`
   - 新增外部距离归一化函数
   - 归一化后再参与筛选
2. `src/services/autoSymbolFinder/types.ts`
   - 明确原始字段与内部字段语义
3. `src/services/autoSymbolFinder/index.ts`
   - 日志输出使用归一化后的内部百分比值
4. `src/config/config.trading.ts`
   - 保持配置层百分比值语义，但注释写清边界关系
5. `src/config/config.validator.ts`
   - 错误文案继续围绕内部百分比值，但补充与 API 原始单位的边界说明
6. `README.md`
   - 修正文档语义
7. `tests/services/autoSymbolFinder/business.test.ts`
   - mock 数据改为真实 API 原始单位
8. `tests/main/startup/seat.business.test.ts`
   - mock 数据改为真实 API 原始单位
9. `tests/integration/auto-search-policy-consistency.integration.test.ts`
   - mock 数据改为真实 API 原始单位
10. 其他所有直接 mock `warrantList.toCallPrice` 的测试

## 9. 实施阶段计划

## 9.1 阶段一：统一单位语义

1. 明确内部运行时单位为“百分比值”。
2. 在自动寻标边界新增 API 原始值归一化逻辑。
3. 更新类型注释与模块说明。

## 9.2 阶段二：修复自动寻标生产逻辑

1. 完成 `autoSymbolFinder` 内部比较与排序的单位统一。
2. 验证启动寻标、运行时寻标、换标预寻标三条入口无需额外改逻辑即可得到正确结果。
3. 复核自动换标距离比较不受回归影响。

## 9.3 阶段三：重建测试基线

1. 把所有 `warrantList.toCallPrice` 相关 mock 改成真实 API 原始单位。
2. 增加真实单位转换测试。
3. 增加实际阈值场景回归测试。

## 9.4 阶段四：文档收口

1. 更新 README。
2. 更新核心注释。
3. 保留本 issue 作为排障与架构决策依据。

## 10. 测试矩阵（必须新增/重写）

## 10.1 自动寻标业务测试

1. 牛证主条件命中：
   - 原始 `toCallPrice=0.0036`
   - 阈值 `0.35`
   - 结果必须命中主条件
2. 牛证降级命中：
   - 原始 `toCallPrice` 位于 `(0.002, 0.0035)` 区间
3. 熊证主条件命中：
   - 原始 `toCallPrice=-0.0036`
   - 阈值 `-0.35`
4. 熊证降级命中：
   - 原始 `toCallPrice` 位于 `(-0.0035, -0.002)` 区间

## 10.2 三入口一致性测试

在同一批候选数据下，以下三条链路必须返回完全一致的 `symbol` 与 `selectionStage`：

1. 启动寻标
2. 运行时自动寻标
3. 距回收价换标预寻标

## 10.3 真实配置回归测试

需要加入至少一组接近真实环境的配置：

1. `HSI.HK`
   - 牛证阈值 `1.85`
   - 熊证阈值 `-1.85`
2. `9988.HK`
   - 牛证阈值 `3.5`
   - 熊证阈值 `-3.5`

通过 mock 候选列表验证：

1. 修复前逻辑会判空。
2. 修复后逻辑会命中候选。

## 10.4 风险与换标一致性测试

需要验证：

1. 自动寻标返回的 `distancePct` 与 `riskChecker.getWarrantDistanceInfo()` 的百分比值口径一致。
2. `switchDistanceRange` 比较仍基于百分比值，不发生边界漂移。

## 11. 验收标准

本次系统性修复完成后，必须满足以下验收标准：

1. 使用真实 API 原始 `toCallPrice` 数据时，自动寻标不再出现大面积误判为空。
2. 启动寻标、运行时自动寻标、换标预寻标三条链路结果一致。
3. 自动寻标测试基线不再依赖错误单位假设。
4. README、类型注释、配置说明三者单位语义一致。
5. 执行 `bun lint`、`bun type-check`、受影响测试后全部通过。

## 12. 本次二次结论

本问题已经完成二次验证，结论明确：

1. 这是一个**生产边界单位归一化缺失**问题。
2. 自动寻标模块是当前系统中唯一直接消费 `warrantList.toCallPrice` 原始小数单位而未统一转换的链路。
3. 该问题已扩散到测试基线与文档认知层，必须按本方案做一次**语义级统一修复**。

只有在统一内部单位、修正自动寻标边界、重建测试基线之后，才算真正完成这次问题的系统性修复。

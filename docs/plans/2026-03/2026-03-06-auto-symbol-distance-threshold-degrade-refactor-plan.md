# 自动寻标距回收价阈值降级筛选系统性重构方案

## 1. 需求复述与目标确认

### 1.1 当前现状

当前自动寻标对距回收价百分比的筛选只有单层主条件：

- 牛证：`distancePct > autoSearchMinDistancePctBull`
- 熊证：`distancePct < autoSearchMinDistancePctBear`
- 两个方向都必须同时满足分均成交额阈值

若没有候选，则直接视为“未找到符合条件的标的”。

### 1.2 新需求的精确定义

在保持分均成交额筛选条件不变的前提下，引入“单次降级筛选”：

- 第 1 层主条件保持不变。
- 第 2 层降级条件只在“第 1 层完全没有命中候选”时启用。
- 牛证降级区间： `switchDistanceRangeBull.min < distancePct < autoSearchMinDistancePctBull`
- 熊证降级区间： `autoSearchMinDistancePctBear < distancePct < switchDistanceRangeBear.max`
- 降级区间内的选优规则：选择“最接近自动寻标阈值”的候选。
- 若降级区间内仍无候选：结果仍为“未找到符合条件的标的”，与当前失败语义保持一致。

### 1.3 本次方案目标

本次不是在现有 `selectBestWarrant` 内加一个临时 `if` 分支，而是将自动寻标统一重构为“方向化寻标策略 + 双层候选带（主条件 / 降级条件）”模型，保证以下链路完全一致：

- 启动时空席位寻标
- 运行时空席位自动寻标
- 距回收价触发换标时的预寻标

## 2. 现状代码阅读结论

### 2.1 当前筛选核心

当前核心筛选逻辑位于：

- `src/services/autoSymbolFinder/utils.ts`
- `src/services/autoSymbolFinder/index.ts`

`selectBestWarrant` 当前同时承担三件事：

- 候选有效性校验
- 单层阈值过滤
- 单一排序规则选优

现有排序口径是：

- 先选“更接近回收价”的候选
- 若距离相同，再选分均成交额更高者

本质上它只支持“主条件命中后直接返回”，不支持“主条件失败后再进入第二候选带”的策略。

### 2.2 当前阈值来源

阈值来源位于：

- `src/types/config.ts`
- `src/config/config.trading.ts`
- `src/config/config.validator.ts`
- `src/services/autoSymbolManager/thresholdResolver.ts`

当前配置已经具备本次重构所需的全部输入：

- 自动寻标阈值
  - `autoSearchMinDistancePctBull`
  - `autoSearchMinDistancePctBear`
- 分均成交额阈值
  - `autoSearchMinTurnoverPerMinuteBull`
  - `autoSearchMinTurnoverPerMinuteBear`
- 距回收价换标区间
  - `switchDistanceRangeBull`
  - `switchDistanceRangeBear`

因此本次需求不需要新增环境变量或配置字段，现有配置足以支撑。

### 2.2.1 当前存在的关键前置风险：距离单位口径未被显式统一

虽然现有配置字段足以表达本次需求，但当前代码存在一个必须先收口的问题：  
**自动寻标阈值、换标区间、候选 `distancePct` 的单位口径在代码与文档中没有被显式统一。**

现状如下：

- `warrantList.toCallPrice` / `riskChecker.getWarrantDistanceInfo().distanceToStrikePercent` 的运行时口径是“百分比值”，例如 `0.35` 表示 `0.35%`
- `AUTO_SEARCH_MIN_DISTANCE_PCT_*` 在 `src/config/config.trading.ts` 中会经过 `/100` 转换
- `SWITCH_DISTANCE_RANGE_*` 当前在 `src/config/config.trading.ts` 中按原值解析，不做 `/100`
- 现有测试与业务常量大量直接使用 `0.35 / -0.35 / 0.3 / -0.3` 这类“百分比值”口径

这意味着如果不先统一口径，就会出现以下风险：

- `autoSearchMinDistancePctBull/Bear` 与 `switchDistanceRangeBull/Bear` 可能无法直接比较
- 方案中定义的降级区间可能被错误判空
- 配置校验即使通过，筛选结果也可能与预期完全相反

因此，本次系统性重构的**第一前置步骤**不是直接改筛选器，而是先把距离单位语义在配置层、运行时类型层、README 和测试中统一下来。

### 2.2.2 当前存在的第二个关键前置风险：数值精度与比较链路不统一

除单位口径外，当前代码还存在数值处理链路不统一的问题：

- 自动寻标筛选中，`warrant.toCallPrice` 先被转为 `number`，再参与比较
- 风控与换标链路中，距回收价百分比由 `Decimal` 计算，但在业务判定前对价格做了 `roundDp(3)`
- 展示格式化与业务判定没有被严格分离

这会带来以下风险：

- 阈值边界附近的候选可能因舍入提前或延后命中
- “最接近阈值”的排序可能因 `Decimal -> number -> Decimal` 往返转换而改变
- 自动寻标筛选结果与运行时换标/风控判断结果可能出现边界漂移

因此，本次方案除了统一单位外，还必须统一**数值判定精度策略**。

### 2.3 当前调用链

当前 `findBestWarrant` 被三条业务链路复用：

- `src/main/startup/seat.ts`
- `src/services/autoSymbolManager/autoSearch.ts`
- `src/services/autoSymbolManager/switchStateMachine.ts`

但三条链路并未完全共享同一套“寻标策略构造逻辑”：

- `autoSearch.ts` 与 `switchStateMachine.ts` 使用 `thresholdResolver`
- `startup/seat.ts` 仍在本地直接拼装阈值

这意味着如果只修改 `autoSearch.ts` / `switchStateMachine.ts`，启动寻标会与运行时寻标出现行为分叉。因此本次必须统一策略源，不能只改运行时路径。

## 3. 可行性分析

结论：**在先完成“距离单位口径统一”前置收口的前提下可行**，且当前架构适合做这次重构。

### 3.1 架构可行性

现有代码已经具备以下基础条件：

- 已存在统一候选入口 `findBestWarrant`
- 已存在方向化阈值解析器 `resolveAutoSearchThresholds`
- 已存在换标触发区间配置，可直接作为降级筛选边界
- 启动、运行时、换标预寻标都已经共享同一候选返回结构

因此，本次重构不需要改动席位状态机、任务队列、风控总线或下单链路，只需要：

- 先统一距离单位口径
- 再把“候选筛选内核”升级为双层策略模型
- 最后统一三条寻标入口的调用方式

### 3.2 业务可行性

新需求与现有业务语义不冲突：

- 主条件优先，保持现有风险偏好不变
- 只有主条件无候选时才允许降级，不会抢占原始候选
- 降级边界直接使用换标阈值内侧，不会选到已经越界、会立即触发换标的标的
- 分均成交额条件保持不变，不会因为降级而放松流动性要求

但要注意：

- 只有当 `autoSearchMinDistancePct*`、`switchDistanceRange*` 与候选 `distancePct` 使用同一单位口径时，上述业务判断才成立
- 因此“单位统一”是业务正确性的组成部分，而不是实现细节

### 3.3 风险边界可控

在单位统一完成后，本次变化只影响“自动寻标候选选取”，不会改变以下口径：

- 买入前牛熊证风险检查
- 距回收价触发换标的触发条件
- 换标失败计数与冻结规则
- 空席位、SEARCHING、SWITCHING、READY 的生命周期

因此这是一次可局部落地、但又必须系统统一的重构。

### 3.4 TypeScript 规范可行性

本次方案可以完整遵守 `typescript-project-specifications`：

- 新增数据结构类型应放入对应模块的 `types.ts`
- 纯筛选函数与比较函数应放入对应模块的 `utils.ts`
- 共享常量若需新增，应放入 `src/constants`
- 不允许在 `startup/seat.ts`、`autoSearch.ts`、`switchStateMachine.ts` 内复制策略构造逻辑
- 策略构造失败属于预期内业务失败，应显式返回失败结果或 `null`，而不是依赖隐式异常
- 实施完成后必须执行 `bun lint` 与 `bun type-check`

### 3.5 数值精度可行性

本次重构可以通过以下方式消除主要精度风险：

- 自动寻标筛选内部全程使用 `Decimal` 比较
- 业务判定与日志展示彻底分离
- 阈值比较、距离差排序、换标边界判断统一使用同一套数值工具

这意味着：

- `number` 只作为最终返回值或日志展示边界使用
- 真正决定业务命中的比较逻辑不再依赖原生浮点

## 4. 合理性分析

结论：合理，且符合当前系统的风险控制方向。

### 4.1 主条件优先符合既有风险偏好

当前系统偏向优先寻找“距回收价更安全、同时又尽量接近阈值”的牛熊证。新需求没有否定这一原则，而是要求：

- 先按原规则寻找
- 找不到时，再在更接近风险边界但尚未触发换标的区间内退一步

这属于“候选池扩展”，不是“风险基线下调”。

### 4.2 降级边界与换标区间天然一致

本次降级区间不是任意放宽，而是严格限制在换标区间的安全内侧：

- 牛证必须仍然大于换标下限
- 熊证必须仍然小于换标上限

因此降级选中的候选虽然更接近风险边界，但仍不会在绑定席位后立刻触发距回收价换标。

### 4.3 保持“无候选即失败”的全局语义

需求第 3 点要求，如果降级区间内仍无候选，则仍视为未找到符合条件的标的。

这与当前系统的失败处理完全兼容：

- 启动寻标失败：保持 EMPTY / 记录失败计数
- 运行时寻标失败：保持 EMPTY / 记录失败计数
- 换标预寻标失败：换标失败并进入现有失败处理

因此不会引入新的状态分支或灰色行为。

## 5. 本次重构的核心设计原则

### 5.1 单一策略源

所有寻标入口必须先构造同一个“方向化寻标策略对象”，再交给统一筛选器执行。不能在：

- `startup/seat.ts`
- `autoSearch.ts`
- `switchStateMachine.ts`

各自拼一套阈值和降级规则。

### 5.1.1 单一单位源

在单一策略源之前，必须先建立**单一距离单位源**。

本方案最终要求：

- 自动寻标主阈值
- 自动换标区间
- 候选 `distancePct`
- 日志展示口径
- 测试数据口径

全部使用同一种内部运行时单位。

推荐统一为：

- **内部运行时统一使用“百分比值”**
- 即 `0.35` 表示 `0.35%`

原因：

- 这与 `warrantList.toCallPrice` 和 `riskChecker.getWarrantDistanceInfo()` 现有运行时结果一致
- 这与当前风控常量 `0.35 / -0.35 / 0.3 / -0.3` 一致
- 这与当前自动寻标测试数据一致

一旦采用该统一口径，则配置解析层必须负责把外部输入规范化到这个运行时单位；不能让筛选器同时兼容多种单位。

### 5.1.2 单一数值比较源

在统一单位之后，还必须建立**单一数值比较源**。

本方案最终要求：

- 自动寻标主条件比较
- 自动寻标降级区间比较
- “最接近阈值”排序比较
- 距回收价换标越界比较
- 牛熊证风险阈值比较

全部使用同一类高精度数值比较方式。

推荐原则：

- 内部业务判定一律使用 `Decimal`
- 仅在日志、UI 展示、最终对外输出时转换为 `number` 或格式化字符串

### 5.2 候选筛选与状态机解耦

本次只重构候选筛选内核，不改动：

- 席位状态迁移
- 换标推进阶段
- 风险检查器缓存
- 监控任务调度

这样可以把变化严格收敛在“寻标决策层”，保证行为边界清晰。

### 5.3 严格避免补丁式实现

禁止采用以下做法：

- 在 `selectBestWarrant` 末尾临时补一个“如果没找到再扫一遍”
- 在 `switchStateMachine.ts` 单独实现降级逻辑
- 在 `startup/seat.ts` 再写一套不同的降级逻辑

这些做法都会让三个入口长期漂移，最终形成三套业务标准。

### 5.4 共享模块边界清晰

不能为了“统一策略源”而让 `main/startup` 直接依赖 `autoSymbolManager` 的内部解析实现。

原因：

- `startup` 是主程序启动域
- `autoSymbolManager` 是运行时席位/换标域
- 若启动域反向依赖运行时内部模块，会让模块边界变差，后续维护成本上升

因此，策略构造逻辑应抽到一个**共享但中立的模块**，由三条入口共同使用，而不是复用某一侧的内部实现。

### 5.5 判定与展示分离

必须显式区分两类数值处理：

- 判定数值：用于业务命中、边界比较、排序
- 展示数值：用于日志、控制台输出、README 示例

禁止在判定链路中使用展示性质的舍入，例如：

- 先 `roundDp(3)` 再做阈值判断
- 先 `toFixed()` 再做区间比较

任何格式化都只能发生在“判定完成之后”。

## 6. 详细重构方案

### 6.1 重构一：引入方向化寻标策略模型

建议将当前“两个标量阈值”重构为统一策略对象，内部语义类似：

- 方向：`LONG | SHORT`
- 主条件目标阈值：`searchThresholdPct`
- 分均成交额阈值：`minTurnoverPerMinute`
- 降级区间下界 / 上界
- 降级是否启用

建议新增内部类型，放在自动寻标相关模块中，而不是散落在调用方局部变量里。推荐新增如下语义对象：

- `DirectionalAutoSearchPolicy`
- `WarrantSelectionStage = 'PRIMARY' | 'DEGRADED'`

其中：

- `DirectionalAutoSearchPolicy` 负责表达“该方向应该如何筛选”
- `WarrantSelectionStage` 负责表达“本次命中的是主条件还是降级条件”

`DirectionalAutoSearchPolicy` 至少应显式包含以下不变量语义：

- `direction`
- `distanceUnit`
- `primaryThreshold`
- `minTurnoverPerMinute`
- `degradedRangeMin`
- `degradedRangeMax`
- `primaryComparator`
- `degradedComparator`

并要求：

- 非法区间在策略构造阶段即失败
- 筛选器只能消费“已构造成功的策略”，不再自行猜测区间是否合法

### 6.1.1 重构零：先统一距离单位口径

这是本次重构必须先于策略建模完成的前置步骤。

#### 目标

统一以下数据的内部运行时单位：

- `autoSearchMinDistancePctBull`
- `autoSearchMinDistancePctBear`
- `switchDistanceRangeBull`
- `switchDistanceRangeBear`
- `WarrantCandidate.distancePct`
- 所有与自动寻标筛选相关的测试数据

#### 方案要求

1. 先确定唯一运行时单位

- 推荐采用“百分比值”口径
- 即 `0.35` 表示 `0.35%`

2. 配置解析层统一归一化

- `config.trading.ts` 必须明确：哪些环境变量输入需要换算，哪些不需要
- 换算结果必须全部落到同一运行时口径

3. 类型和注释同步修正

- `src/types/config.ts`
- `src/services/autoSymbolFinder/types.ts`
- `README.md`
- 相关测试工厂与测试命名

4. 在统一前不得开始降级区间比较逻辑实现

因为此时任何 `<` / `>` 比较都可能是错的。

### 6.1.2 重构零点五：先统一数值判定精度策略

这是与“单位统一”并列的前置步骤。

#### 目标

统一以下业务比较链路的数值实现方式：

- 自动寻标主条件比较
- 自动寻标降级区间比较
- 自动寻标排序差值比较
- 距回收价换标越界判断
- 牛熊证风控阈值判断

#### 方案要求

1. 判定阶段全程使用 `Decimal`

- 候选 `distancePct` 在进入筛选引擎后，不应先转为 `number`
- 阈值与区间边界在比较前，应统一转为 `Decimal`
- 排序时的“与阈值差值”也应使用 `Decimal`

2. 展示阶段单独格式化

- `formatDecimal` 只用于展示
- 不得把 `roundDp` 结果反向参与业务判断

3. 旧有前置舍入必须移出业务判断链路

- 若当前距回收价百分比计算中存在价格预先 `roundDp(3)`，应评估并移出判定链路
- 若为了与外部行情展示一致需要保留三位小数，必须只在展示层保留

4. 比较工具统一复用

- 不允许一部分链路用 `number > number`
- 另一部分链路用 `decimalGt`
- 应统一为同一套高精度比较工具

### 6.2 重构二：阈值解析器升级为策略解析器

当前 `thresholdResolver.ts` 只返回：

- `minDistancePct`
- `minTurnoverPerMinute`
- `switchDistanceRange`

这不足以表达“双层候选带”。

但这次不应继续把升级后的策略构造放在 `autoSymbolManager/thresholdResolver.ts` 里作为运行时私有实现。

更合理的模块边界是：

- 在 `autoSymbolFinder` 域内新增共享 policy builder，或
- 抽取到独立的自动寻标共享策略模块

供以下三条链路共同消费：

- `startup/seat.ts`
- `autoSearch.ts`
- `switchStateMachine.ts`

应将其升级为“策略解析器”，统一输出完整策略：

#### 牛证策略

- 主条件：`distancePct > threshold`
- 降级条件：`lowerBound < distancePct < threshold`
- 其中：
  - `threshold = autoSearchMinDistancePctBull`
  - `lowerBound = switchDistanceRangeBull.min`

#### 熊证策略

- 主条件：`distancePct < threshold`
- 降级条件：`threshold < distancePct < upperBound`
- 其中：
  - `threshold = autoSearchMinDistancePctBear`
  - `upperBound = switchDistanceRangeBear.max`

这样之后：

- `startup/seat.ts`
- `autoSearch.ts`
- `switchStateMachine.ts`

都不再自己理解牛熊方向比较关系，而是只消费统一策略对象。

### 6.2.1 策略构造边界必须自带不变量校验

不能只在 `config.validator.ts` 里校验区间合法性。

还必须在策略构造函数内部再次校验：

- 主阈值存在
- 成交额阈值存在
- 降级区间边界存在
- 牛证满足 `degradedRangeMin < primaryThreshold`
- 熊证满足 `primaryThreshold < degradedRangeMax`
- 所有值单位一致

建议策略构造层返回显式结果语义，例如：

- 成功：返回 `DirectionalAutoSearchPolicy`
- 失败：返回 `null` 或 Result 风格失败对象

这样可以满足 TypeScript 规范中“预期内错误显式化”的要求，并把不变量锁在构造边界。

### 6.3 重构三：筛选引擎改为“双层候选带”模型

`selectBestWarrant` 需要从“单层过滤器”重构为“双层候选带筛选器”。

建议拆成四段职责：

1. 候选基础校验
2. 共有流动性校验
3. 主条件候选收集与排序
4. 降级条件候选收集与排序

筛选引擎在本次重构中还必须新增一条硬约束：

- **内部候选比较不得把 `distancePct` 提前降为 `number`**

#### 6.3.1 基础校验保持不变

以下过滤条件保持现有口径：

- `symbol` 必须存在
- `status` 必须为 `Normal`
- `callPrice` 必须有效且大于 0
- `distancePct` 必须可解析
- `turnover` 必须有效且大于 0
- `turnoverPerMinute` 必须达到阈值

#### 6.3.2 主条件与降级条件共用同一流动性过滤

需求明确要求：

- 分均成交额的筛选条件不变

因此主条件与降级条件都必须先通过同一套成交额校验，再根据距回收价区间决定属于哪一个候选带。

#### 6.3.3 主条件排序规则

主条件排序逻辑应显式改写为“距离自动寻标阈值最近优先”，而不是继续隐含为“绝对值更小优先”。

虽然当前实现对现有主条件来说等价，但在引入降级后，必须把排序目标写清楚，否则代码语义会变得模糊。

主条件排序口径：

- 牛证：在 `distancePct > threshold` 中选 `distancePct` 最接近 `threshold` 的
- 熊证：在 `distancePct < threshold` 中选 `distancePct` 最接近 `threshold` 的
- 若距离差相同：分均成交额更高者优先
- 若仍相同：保持现有列表顺序

这里的“距离差”应明确定义为：

- `abs(distancePct - threshold)`

并且必须以 `Decimal` 计算。

#### 6.3.4 降级条件排序规则

降级条件排序口径：

- 牛证：在 `(lowerBound, threshold)` 内选最接近 `threshold` 的
- 熊证：在 `(threshold, upperBound)` 内选最接近 `threshold` 的
- 若距离差相同：分均成交额更高者优先
- 若仍相同：保持现有列表顺序

同样，这里的“最接近阈值”必须基于 `Decimal` 差值，而不是原生 `number` 差值。

#### 6.3.5 主条件绝对优先于降级条件

最终决策顺序必须固定：

1. 若主条件有候选，只能从主条件候选中返回
2. 只有主条件完全为空，才允许进入降级候选带
3. 降级候选带也为空，则返回 `null`

这一点必须写成显式控制流，不能靠排序混在同一个数组里处理，否则无法保证“主条件绝对优先”。

### 6.4 重构四：候选结果增加命中阶段信息

建议扩展 `WarrantCandidate`，新增：

- `selectionStage: 'PRIMARY' | 'DEGRADED'`

如有必要，还应补充：

- `distanceDeltaToThreshold`

用于日志和测试中显式验证“最接近阈值”的排序结果，避免测试只能间接判断。

原因：

- 日志需要知道本次是否走了降级
- 启动寻标、运行时寻标、换标预寻标都应该能记录这一事实
- 后续验证和排障必须能区分“是主条件命中”还是“降级命中”

### 6.5 重构五：统一三条寻标入口

当前三条入口中，`startup/seat.ts` 仍在本地拼装阈值并直接调用 `findBestWarrant`。本次必须统一为：

- `startup/seat.ts` 使用与运行时相同的策略构造逻辑
- `autoSearch.ts` 使用统一策略对象
- `switchStateMachine.ts` 的预寻标也使用同一策略对象

目标是让三条链路在相同配置、相同候选列表下得到完全一致的结果。

这里要补充一条架构约束：

- `startup/seat.ts` 不应直接引用 `autoSymbolManager` 的私有阈值解析器

而应改为三条链路共同依赖一个中立的共享策略构造模块。

### 6.6 重构六：配置校验增加“降级区间有效性”约束

当前配置验证只检查：

- 阈值是否存在
- `switchDistanceRange` 是否存在
- `min <= max`

这对本次需求不够。

必须新增以下业务校验：

#### 牛证

- `switchDistanceRangeBull.min < autoSearchMinDistancePctBull`

否则牛证降级区间为空或反向，需求无法成立。

#### 熊证

- `autoSearchMinDistancePctBear < switchDistanceRangeBear.max`

否则熊证降级区间为空或反向，需求无法成立。

注意：

- 本次只增加“降级区间有效性”校验
- 不额外改变主条件与 `switchDistanceRange.max/min` 的既有关系

这样可以严格满足本次需求，而不引入用户未要求的新业务限制。

但这里还不够完整，配置校验还必须增加“单位一致性”的文档化约束：

- README 中应明确环境变量的填写单位
- validator 的报错文案应明确比较口径
- 若配置层存在历史口径迁移，应在方案中明确采用哪一种最终口径，不保留双口径兼容逻辑

### 6.7 重构七：日志语义同步升级

当前 `findBestWarrant` 在找不到候选时只会记录“未找到符合条件的牛/熊证”。

重构后日志应区分三类结果：

#### 主条件命中

- 记录命中方向
- 记录候选代码
- 记录距回收价百分比
- 记录分均成交额
- 记录 `selectionStage=PRIMARY`

#### 降级条件命中

- 明确记录“主条件无候选，启用降级区间后命中”
- 记录候选代码
- 记录距回收价百分比
- 记录阈值与降级边界
- 记录 `selectionStage=DEGRADED`

#### 全部失败

- 记录“主条件与降级条件均未命中”
- 记录列表条数、交易分钟数
- 必要时记录方向阈值与降级边界

这不是附加功能，而是本次重构验证逻辑正确性的必要输出。

### 6.7.1 日志数值必须来自判定后快照

日志输出时，必须遵守以下原则：

- 先完成业务判定
- 再对判定结果中的距离值做展示格式化

不能出现：

- 为了日志打印，把数值先格式化后再参与比较
- 因日志需求引入新的前置舍入逻辑

### 6.8 重构八：测试与文档同步纳入实施范围

为了满足“系统性且完整性”的要求，本次实施范围必须显式包含：

- `tests/services/autoSymbolFinder`
- `tests/services/autoSymbolManager/autoSearch.business.test.ts`
- `tests/services/autoSymbolManager/switchStateMachine.business.test.ts`
- `tests/main/startup/seat.business.test.ts`
- 相关 integration tests
- `README.md`

原因：

- 当前自动寻标测试大量直接使用 `0.35` 口径
- 若单位统一或策略对象落地，测试和 README 不同步更新，就会形成文档与实现漂移

### 6.9 重构九：命名语义与模块组织要求

为满足 `typescript-project-specifications`，本次实现时应遵守以下要求：

- 策略数据结构放入对应 `types.ts`
- 纯比较/排序函数放入对应 `utils.ts`
- 不新增“旧接口委托新接口”的兼容式包装器
- 若 `selectBestWarrant` 语义发生变化，应直接升级或替换命名，避免保留语义失真的旧名称
- 不允许在调用点保留临时布尔分支解释“是否降级”，而应由策略模型直接表达

### 6.10 重构十：风控与换标链路的数值口径同步

虽然本次需求直接修改的是自动寻标，但实现时必须同步检查以下链路是否仍存在判定前舍入：

- `warrantRiskChecker.ts` 中的距回收价百分比计算
- `switchStateMachine.ts` 中的换标越界比较

要求：

- 风控判断与换标判断的比较精度策略必须与自动寻标一致
- 若保留不同口径，必须在方案中证明其合理性；否则视为不允许

本方案默认结论是：

- **不应保留不同判定精度策略**

## 7. 全链路影响分析

### 7.1 启动寻标链路

影响文件：

- `src/main/startup/seat.ts`

变化点：

- 启动寻标不再本地解析牛/熊阈值
- 改为走统一策略解析器
- 启动寻标命中降级候选时，仍按正常 READY 席位处理
- 若主条件和降级条件都失败，则保持当前 EMPTY + 失败计数行为

### 7.2 运行时空席位自动寻标链路

影响文件：

- `src/services/autoSymbolManager/autoSearch.ts`

变化点：

- 逻辑主干不变
- 仅把输入从“两个标量阈值”替换为“完整策略对象”
- 当降级命中时，席位依然正常进入 READY

### 7.3 距回收价换标预寻标链路

影响文件：

- `src/services/autoSymbolManager/switchStateMachine.ts`

变化点：

- 预寻标同样使用统一策略
- 若主条件无候选但降级命中，则允许换标命中新候选
- 若降级命中的仍是当前旧标的，仍按现有“同标的抑制”处理
- 若主条件与降级条件都无候选，则继续走现有换标失败语义

### 7.4 距回收价触发换标链路本身

影响文件：

- `src/services/autoSymbolManager/switchStateMachine.ts`

不变点：

- 触发换标的越界规则不变
- `distance <= min` 或 `distance >= max` 的触发规则不变
- 本次只改变“触发后寻找新标的的候选规则”

### 7.5 买入风险检查链路

影响文件：

- `src/core/riskController/warrantRiskChecker.ts`

不变点：

- 买入前牛熊证风险阈值完全不变
- 不因为自动寻标支持降级，就放宽买入前风控口径

这是必须保持的业务边界，否则会把“寻标策略降级”误扩散成“交易风控降级”。

## 8. 实施顺序

建议按以下顺序实施，避免中途出现三套标准并存：

1. 先统一距离单位口径，并修正配置注释、README 与测试基线
2. 新增内部策略类型与候选阶段类型
3. 抽取中立的共享策略构造模块
4. 在策略构造边界加入不变量校验
5. 重构 `autoSymbolFinder/types.ts` 与 `utils.ts`
6. 重构 `findBestWarrant` 的日志与返回结果
7. 替换 `autoSearch.ts` 的调用方式
8. 替换 `switchStateMachine.ts` 的调用方式
9. 替换 `startup/seat.ts` 的本地阈值拼装
10. 最后补充 `config.validator.ts` 的降级区间有效性校验与错误文案

这个顺序能保证“策略源先统一，再替换调用点”，避免启动链路与运行时链路短暂分叉。

## 9. 全链路验证方案

### 9.1 配置层验证

必须覆盖以下配置场景：

1. 牛证：`switchMin < threshold`
2. 牛证：`switchMin = threshold`
3. 牛证：`switchMin > threshold`
4. 熊证：`threshold < switchMax`
5. 熊证：`threshold = switchMax`
6. 熊证：`threshold > switchMax`

预期：

- 1、4 通过
- 2、3、5、6 报配置错误

### 9.1.1 单位口径验证

必须新增以下验证：

1. 环境变量输入经解析后，`autoSearchMinDistancePct*` 与预期运行时单位一致
2. `switchDistanceRange*` 经解析后，与 `distancePct` 可直接比较
3. README 示例值、测试数据值、运行时日志值三者口径一致

这是本次重构的前置验收点。

### 9.2 候选筛选验证

#### 牛证

1. 主条件有候选，直接选主条件
2. 主条件无候选，降级区间有候选，选最接近阈值者
3. 主条件和降级区间都无候选，返回 `null`
4. 候选等于主阈值，不应命中任一层
5. 候选等于降级边界，不应命中降级层
6. 候选距阈值相同，分均成交额更高者胜出

#### 数值边界补充验证

必须新增以下边界测试：

1. 候选值恰好等于主阈值
2. 候选值仅比主阈值大极小量
3. 候选值仅比主阈值小极小量
4. 两个候选都满足主条件，且与阈值差值极接近
5. 两个候选差值仅在高精度下才能区分

这些测试用于验证：

- 不会因原生浮点误差错误换序
- 不会因前置舍入把边界内值判到边界外

#### 熊证

1. 主条件有候选，直接选主条件
2. 主条件无候选，降级区间有候选，选最接近阈值者
3. 主条件和降级区间都无候选，返回 `null`
4. 候选等于主阈值，不应命中任一层
5. 候选等于降级边界，不应命中降级层
6. 候选距阈值相同，分均成交额更高者胜出

### 9.3 三条入口一致性验证

必须验证在同一组候选数据下，下列三条链路得到相同结果：

1. 启动时寻标
2. 运行时空席位自动寻标
3. 距回收价换标预寻标

这是本次系统性重构最关键的验收点之一。

并且要增加一个更严格的断言：

- 三条链路不仅候选 `symbol` 一致，`selectionStage` 也必须一致

### 9.4 行为不回归验证

必须验证以下行为保持不变：

1. 分均成交额不达标的候选，不会因为降级而被放行
2. 主条件命中时，降级候选即使更接近阈值也不得被选中
3. 主条件与降级条件都失败时，失败计数与冻结逻辑保持现有语义
4. 换标触发条件本身不改变
5. 买入前牛熊证风险检查不改变

### 9.4.1 精度一致性验证

必须新增以下验证：

1. 自动寻标主筛选结果与换标越界判断在相同距离值下口径一致
2. 自动寻标筛选结果与牛熊证风险判断在阈值邻域内没有异常反转
3. 任何日志格式化操作都不会改变最终业务命中结果

### 9.5 规范性验证

实施完成后必须执行：

1. `bun lint`
2. `bun type-check`

并同步检查：

- 新增类型是否放在对应 `types.ts`
- 新增纯函数是否放在对应 `utils.ts`
- 注释是否与新逻辑一致
- README 是否与最终实现一致

## 10. 方案结论

### 10.1 可行性结论

可行，但前提是先完成“单位口径统一”。

原因：

- 当前架构已经具备统一寻标入口
- 当前配置已具备降级边界来源
- 在先修正单位口径后，变更范围可以严格收敛在“策略解析 + 候选筛选 + 三个调用点统一”

### 10.2 合理性结论

合理。

原因：

- 完整保留主条件优先原则
- 降级区间被限制在换标边界内侧，风险边界明确
- 不改变失败语义、不改变风控语义、不改变状态机语义

### 10.3 二次复核后的最终判断

二次复核后，本方案可以作为实施依据，但必须把以下三点视为不可跳过的硬要求：

1. 先统一距离单位口径，再做降级筛选
2. 共享策略构造必须落在中立模块，不能让 `startup` 反向依赖运行时私有实现
3. 不变量校验必须同时存在于 `config.validator.ts` 与策略构造边界

### 10.3.1 精度风险纳入后的最终硬要求

除上述三点外，还必须新增第四点硬要求：

4. 所有距回收价业务判定必须统一为“高精度判定、展示后格式化”，禁止判定前舍入

### 10.4 最终实施建议

按本方案执行时，应将本次需求落实为一次“自动寻标策略内核重构”：

- 统一策略对象
- 统一筛选引擎
- 统一三条寻标入口
- 统一配置有效性校验
- 统一日志与验证口径
- 统一数值判定精度策略

只有这样，才能满足“系统性且完整性的重构”要求，并避免后续再次出现启动、运行时、换标三条链路行为不一致的问题。

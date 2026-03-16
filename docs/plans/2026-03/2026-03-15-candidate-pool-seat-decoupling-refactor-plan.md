# 候选池与占用席位解耦重构方案

> 日期：2026-03-15  
> 范围：重构自动寻标、席位、买入选标、周期换标、距离换标、启动恢复与行情订阅模型。  
> 目标：将“候选可买标的集合”和“当前持仓归属标的”彻底拆成两套独立运行时状态，不允许兼容式双轨方案，不允许补丁式保留旧席位语义。

## 1. 文档目的

本文档用于对以下新需求进行一次完整、可执行、非补丁式的重构设计：

1. 自动寻标不再直接给出唯一席位标的，而是给出最多十个候选标的。
2. 候选标的需要订阅 `Quote`、`Depth`、`Trades` 三类实时数据。
3. 只有在真正买入并建立持仓后，成交标的才占用席位。
4. 清仓后立即释放席位，重新回到空席位，仅保留候选池。
5. 启动恢复时若该方向已有持仓，则继续使用持仓标的占用席位。
6. 周期换标与距离换标都重写为“候选池刷新 + 持仓时按规则移仓”的新语义。
7. 候选列表刷新若与上一版完全相同，则触发当日抑制并停止当日自动刷新。

本文档回答以下问题：

1. 当前系统的根本前提为什么必须被替换，而不能局部修补。
2. 新的运行时模型应该如何定义。
3. 新模型下各业务链路如何重建。
4. 现有哪些模块必须删除、重写或保留。
5. 应按什么实施顺序落地，才能保证语义正确且改造路径最短。

---

## 2. 需求确认

本次方案基于以下已确认约束：

1. 买入信号允许在入队时不携带具体 warrant `symbol`，实际买入标的在执行阶段再选出。
2. 若当前持仓标的距回收价百分比进入超阈值区间，仍然需要移仓：
   1. 先清仓原标的。
   2. 再从候选列表中选出新的最优买入标的。
   3. 整体语义接近当前距离换标，但候选来源改为候选池。
3. 当候选池刷新后若新列表与上一版完全相同，则触发当日抑制，并停止当日所有自动刷新。

以上三点已经锁定，本方案不再保留其他兼容解释。

---

## 3. 第一性原理分析

### 3.1 当前系统把三件事混成了一件事

当前系统中的 `SeatState(symbol, status)` 同时表达了三层业务含义：

1. 这个方向当前“能买什么”。
2. 这个方向当前“下一笔应该买什么”。
3. 这个方向当前“实际持有的是什么”。

这是当前架构的核心问题，因为这三件事并不等价。

### 3.2 新需求要求把“观察对象”和“持仓对象”拆开

从业务事实出发：

1. 候选池回答的是“哪些标的值得持续订阅并在买入时比较”。
2. 占用席位回答的是“当前持仓与卖出、风控、恢复归属依赖哪个标的”。

因此，新系统必须存在两套独立状态：

1. `CandidatePool`
2. `OccupiedSeat`

只要继续让 `SeatState` 同时承担这两种语义，后续所有逻辑都会回到旧模型。

### 3.3 最短路径不是“小修自动寻标”，而是重定义运行时对象

若只在现有 `autoSymbolManager` 上增加候选列表字段，而继续保留：

1. 自动寻标成功就写入 `READY + symbol`
2. 买入/卖出/风控继续围绕 READY 席位标的展开

那么买入时延迟选标、空仓不占席位、候选池订阅、候选池抑制、超阈值踢出等需求都无法自洽。

因此，本次重构的最短正确路径只有一条：

1. 删除“自动寻标 = 占用席位”的前提。
2. 重建为“候选池准备”和“持仓席位占用”两条独立链路。

---

## 4. 当前系统事实

### 4.1 当前自动寻标返回的是唯一候选

当前 `autoSymbolFinder` 只返回单个 `WarrantCandidate`，并按以下规则选优：

1. 先按距主阈值更近优先。
2. 若差值相同，再按分均成交额更高优先。
3. 最终只保留一个最佳标的。

相关实现：

1. `src/services/autoSymbolFinder/utils.ts`
2. `src/services/autoSymbolFinder/index.ts`

### 4.2 当前自动寻标成功后立即把标的写入席位

当前 `autoSearch` 语义是：

1. 空席位触发寻标。
2. 找到最佳标的后，直接把该标的写入 `SeatState(status=READY, symbol=best.symbol)`。
3. 后续信号生成、风控、换标都基于该席位标的展开。

这与新需求直接冲突。

### 4.3 当前大量链路都依赖“席位 READY 且有 symbol”

以下链路都把 `READY + symbol` 当作基础事实：

1. `signalPipeline`
2. `buyProcessor`
3. `sellProcessor`
4. `seatSync`
5. `riskTasks`
6. `switchStateMachine`
7. `seatPreparation`
8. `postTradeRefresher`
9. `loadTradingDayRuntimeSnapshot`

因此本次不能局部换掉 `findBestWarrant` 的返回值，而必须重建整条“席位语义”。

### 4.4 Longbridge API 能力足够支撑新模型

基于 Longbridge API / SDK，可直接支撑本次重构所需的数据能力：

1. 候选获取：
   1. `warrantList(...)`
2. 候选实时行情订阅：
   1. `Quote`
   2. `Depth`
   3. `Trades`
3. 候选实时拉取兜底：
   1. `realtimeQuote`
   2. `realtimeDepth`
   3. `realtimeTrades`

因此本次需求没有 API 能力缺口，缺的是运行时模型重构。

---

## 5. 新目标架构

## 5.1 新的两层运行时对象

每个 `monitorSymbol + direction` 维护以下两套独立状态。

### A. 候选池 `CandidatePoolState`

职责：

1. 表达该方向当前最多十个候选标的。
2. 表达这些候选的刷新状态、抑制状态、失败计数与冻结状态。
3. 表达该方向需要维持的候选行情订阅集合。
4. 为买入执行瞬间提供选择输入。

建议字段：

1. `status: 'EMPTY' | 'POPULATING' | 'READY' | 'SUPPRESSED_TODAY' | 'FROZEN_TODAY'`
2. `candidates: ReadonlyArray<CandidateSymbolEntry>`
3. `lastRefreshAtMs: number | null`
4. `lastSuppressedAtMs: number | null`
5. `searchFailCountToday: number`
6. `frozenTradingDayKey: string | null`
7. `suppressedTradingDayKey: string | null`
8. `lastListFingerprint: string | null`
9. `excludedSymbols: ReadonlySet<string>`

其中 `CandidateSymbolEntry` 建议至少包含：

1. `symbol`
2. `name`
3. `callPrice`
4. `distancePct`
5. `turnoverPerMinute`
6. `selectionStage`

### B. 占用席位 `OccupiedSeatState`

职责：

1. 只表达当前真实持仓归属的 warrant 标的。
2. 只服务于买后归属、卖出、风控、刷新、恢复和移仓。

建议字段：

1. `status: 'UNOCCUPIED' | 'OCCUPYING' | 'OCCUPIED'`
2. `symbol: string | null`
3. `seatVersion: number`
4. `callPrice: number | null`
5. `lastOccupiedAtMs: number | null`
6. `lastExitAtMs: number | null`

`OCCUPYING` 用于承接“买单已提交但尚未最终确认归属”的短暂态，避免重复占用或并发污染。

## 5.2 新的监控上下文视图

`MonitorContext` 不再直接暴露“long/short READY symbol”作为唯一交易对象，而是区分：

1. `longCandidatePool`
2. `shortCandidatePool`
3. `longOccupiedSeat`
4. `shortOccupiedSeat`

原先 `longSymbol / shortSymbol / longQuote / shortQuote` 这类单席位字段不能继续作为主视图，必须改为：

1. 仅对 `OccupiedSeat` 暴露“当前持仓标的视图”
2. 对 `CandidatePool` 暴露“候选池列表视图”

---

## 6. 新业务语义

## 6.1 寻标语义

自动寻标不再意味着“找一个席位标的”，而是意味着：

1. 生成一个方向候选池快照。
2. 候选池包含最多十个候选。
3. 主条件不足十个时，再由降级条件补足。
4. 一个都没有则本轮失败，等待下次重试。

## 6.2 买入语义

买入流程改成：

1. 策略产生方向买入信号，仅绑定 `monitorSymbol + direction`。
2. 执行阶段从该方向 `CandidatePool` 中选出当前最优标的。
3. 买单提交成功后进入 `OCCUPYING`。
4. 订单成交确认后写入 `OccupiedSeat` 并进入 `OCCUPIED`。

## 6.3 卖出语义

卖出必须始终绑定 `OccupiedSeat.symbol`，因为卖出语义只对真实持仓成立。

## 6.4 空仓释放语义

当某方向满足：

1. 无持仓
2. 无待成交买单
3. 无待成交卖单剩余归属依赖

则该方向：

1. 清空 `OccupiedSeat`
2. 保留 `CandidatePool`
3. 不再继续把原标的视为席位标的

## 6.5 恢复语义

启动恢复改成：

1. 若某方向有持仓支撑的历史标的，直接恢复 `OccupiedSeat = OCCUPIED`
2. 若无持仓，则 `OccupiedSeat = UNOCCUPIED`
3. `CandidatePool` 是否刷新独立判断，不再由恢复时写入 READY 席位标的

---

## 7. 候选池刷新规则

## 7.1 候选构建规则

单次刷新输出：

1. 主条件候选列表
2. 降级条件候选列表
3. 最终合并后的前十候选

规则：

1. 主条件先入池。
2. 若主条件不足十个，再按降级条件补足。
3. 总数最多十个。
4. 若主条件和降级条件都为空，则刷新失败。

## 7.2 候选排序规则

为保证列表稳定性与可预测性，排序建议固定为：

1. 先按 `selectionStage`，`PRIMARY` 优先于 `DEGRADED`
2. 再按 `distanceDeltaToThreshold` 更小优先
3. 再按 `turnoverPerMinute` 更高优先
4. 最后按 `symbol` 字典序稳定打平

本次不再返回“唯一最佳标的”，而是返回“稳定排序后的候选池快照”。

## 7.3 候选池指纹

为支持当日抑制，必须为候选池计算列表指纹。

指纹建议定义为：

1. 候选列表按最终顺序取 `symbol`
2. 使用 `symbol1|symbol2|...|symbolN` 生成稳定字符串

抑制规则：

1. 若新指纹与上一版完全一致，则触发 `SUPPRESSED_TODAY`
2. 当日内停止该方向所有自动刷新

注意：

1. 必须要求“顺序完全一致”
2. 只要有一个位置变化，都不触发抑制

## 7.4 超阈值踢出规则

当候选池中某标的距回收价进入超阈值区间时：

1. 从候选池中移除该标的
2. 将其加入 `excludedSymbols`
3. 若候选池剩余数量少于 5，则触发全量刷新

该规则只影响后续候选，不直接影响持仓归属。

---

## 8. 买入时选标规则

## 8.1 输入

`candidateSelector` 在买入执行瞬间读取：

1. 当前方向 `CandidatePool`
2. 每个候选的 `Quote`
3. 每个候选的 `Depth`
4. 每个候选的 `Trades`
5. 本次目标下单金额 / 数量

## 8.2 过滤顺序

建议按以下顺序过滤：

1. 候选仍在池中
2. `Quote` 有效且时间新鲜
3. `Depth` 有效，至少存在一档对手盘
4. `Trades` 最近窗口内有成交
5. 若为买入，则对手盘累计可成交金额满足最小要求

## 8.3 排序规则

建议第一版按以下顺序选“最优买入标的”：

1. 预估冲击成本更小
2. 对手盘前三档累计金额更大
3. 最近 5 秒成交更连续
4. `spreadPct` 更小
5. `selectionStage` 更优
6. `distanceDeltaToThreshold` 更小
7. `turnoverPerMinute` 更高

这里的“预估冲击成本”定义为：

1. 按目标下单金额从 `ask1 ~ askN` 向上累加
2. 计算加权成交价
3. 与 `ask1` 比较得到预估滑点

该模型不依赖补丁逻辑，直接使用候选订阅数据做实时决策。

## 8.4 输出

输出必须是：

1. 具体 `symbol`
2. 当次选中依据快照
3. 用于写日志和后续归属的选择理由

---

## 9. 移仓语义重写

## 9.1 周期换标

周期换标重写为：

1. `OccupiedSeat = UNOCCUPIED`
   1. 仅刷新候选池
2. `OccupiedSeat = OCCUPIED`
   1. 若仍有持仓，则进入“等待空仓后刷新候选池”
   2. 若已空仓，则刷新候选池

这意味着旧的周期换标状态机不再做“清席位并绑定新标”，而只管理：

1. 是否需要刷新候选池
2. 是否等待空仓

## 9.2 距离换标

距离换标的业务目标保持“需要移仓”，但实现语义变为：

1. 发现 `OccupiedSeat.symbol` 距回收价超阈值
2. 若该方向已有进行中的移仓链路，则继续推进
3. 否则：
   1. 确保候选池可用，必要时先刷新候选池
   2. 从候选池中排除当前旧标的
   3. 先卖出旧标的
   4. 旧标的清仓完成后，再从候选池中选择新的最优买入标的
   5. 买入新标的并完成占用席位切换

这与当前“换标前预寻标一个 symbol，再直接绑定 nextSymbol”的模型不同。

## 9.3 新的移仓状态机

建议独立新增 `seatSwitchManager`，仅服务于 `OccupiedSeat`，状态建议为：

1. `IDLE`
2. `REFRESH_CANDIDATES`
3. `SELL_OLD`
4. `WAIT_OLD_FLAT`
5. `SELECT_NEW`
6. `BUY_NEW`
7. `WAIT_NEW_FILL`
8. `COMPLETE`
9. `FAILED`

旧的 `switchStateMachine` 必须废弃，不应继续使用“nextSymbol 预绑定”语义。

---

## 10. 订阅模型重构

## 10.1 新的订阅集合

运行时订阅集合需要由三部分并集构成：

1. 所有 `monitorSymbol`
2. 所有 `OccupiedSeat.symbol`
3. 所有 `CandidatePool.candidates[*].symbol`

## 10.2 候选池订阅类型

对候选标的必须同时订阅：

1. `Quote`
2. `Depth`
3. `Trades`

对占用席位标的也建议维持这三类订阅，以统一移仓和风控输入。

## 10.3 订阅边界

必须显式新增候选订阅缓存，不能继续只用当前 `Quote` 缓存模型。

建议新增：

1. `candidateQuoteCache`
2. `candidateDepthCache`
3. `candidateTradesCache`

或者统一为：

1. `symbolMarketSnapshotStore`

后者更短路径，因为可以复用到占用席位与候选池。

---

## 11. 主要模块重构方案

## 11.1 删除旧前提的模块

以下模块的核心语义必须被替换：

1. `src/services/autoSymbolManager/autoSearch.ts`
2. `src/services/autoSymbolManager/switchStateMachine.ts`
3. `src/services/autoSymbolManager/seatStateManager.ts`
4. `src/services/autoSymbolManager/utils.ts` 中依赖 READY symbol 的校验逻辑

这些模块当前都把“选中 symbol = READY 席位”当作基础事实。

## 11.2 新增模块

建议新增以下模块：

1. `src/services/candidatePoolManager/index.ts`
2. `src/services/candidatePoolManager/types.ts`
3. `src/services/candidatePoolManager/refreshFlow.ts`
4. `src/services/candidatePoolManager/suppressionFlow.ts`
5. `src/services/occupiedSeatManager/index.ts`
6. `src/services/occupiedSeatManager/types.ts`
7. `src/services/occupiedSeatManager/occupancyFlow.ts`
8. `src/services/seatSwitchManager/index.ts`
9. `src/services/seatSwitchManager/types.ts`
10. `src/services/candidateSelector/index.ts`
11. `src/services/candidateSelector/types.ts`

## 11.3 `autoSymbolFinder` 重构

`autoSymbolFinder` 改造为：

1. `findBestWarrant` 删除
2. 改为 `findCandidateWarrants`
3. 输出：
   1. `primaryCandidates`
   2. `degradedCandidates`
   3. `selectedCandidates`

`selectedCandidates` 就是最终前十列表。

## 11.4 `SymbolRegistry` 重构

当前 `SymbolRegistry` 必须拆为两个注册表：

1. `CandidatePoolRegistry`
2. `OccupiedSeatRegistry`

不得继续让候选池塞进 `SeatState`。

## 11.5 `seatPreparation` 重构

启动恢复重构为：

1. 先恢复 `OccupiedSeat`
2. 再按方向判断是否需要刷新候选池
3. 返回：
   1. `occupiedSeatSymbols`
   2. `candidatePoolSymbols`

而不是当前的 `seatSymbols`

## 11.6 `createMonitorContext` / `seatSync` 重构

`MonitorContext` 要从“席位视图”改成“候选池 + 占用席位双视图”。

`seatSync` 重写目标：

1. 同步候选池状态
2. 同步占用席位状态
3. 占用席位从 `OCCUPIED -> UNOCCUPIED` 时清理与持仓标的绑定的队列
4. 候选池刷新时不清理持仓队列

## 11.7 `signalPipeline` 重构

买入信号重写：

1. 不再要求 `signal.symbol` 已存在
2. 不再校验买入信号与 READY 席位 symbol 一致
3. 只校验：
   1. 方向存在可用候选池
   2. 占用席位状态是否允许开新仓

卖出信号保持绑定 `OccupiedSeat.symbol`

## 11.8 `buyProcessor` 重构

核心变化：

1. 风险检查前先通过 `candidateSelector` 选定当次 symbol
2. 风险检查使用“选中的实际下单标的”
3. 下单成功后进入 `OCCUPYING`
4. 成交后由订单回报链路完成 `OccupiedSeat` 正式写入

## 11.9 `sellProcessor` 重构

卖出完全基于 `OccupiedSeat`。

## 11.10 风控与监控任务重构

以下任务只应对 `OccupiedSeat` 生效：

1. 浮亏监控
2. 距回收价清仓
3. 智能平仓
4. 保护性清仓
5. 成交后刷新

以下任务应对 `CandidatePool` 生效：

1. 候选池刷新
2. 候选超阈值踢出
3. 候选订阅更新

---

## 12. 新的主链路

## 12.1 启动 / 开盘重建

顺序建议固定为：

1. 恢复订单与持仓
2. 恢复 `OccupiedSeat`
3. 刷新或初始化 `CandidatePool`
4. 建立候选和占用标的行情订阅
5. 创建 `MonitorContext`
6. 放行运行时交易

## 12.2 正常运行

顺序建议固定为：

1. 时间链路推进
2. 候选池刷新链路推进
3. 市场数据推进
4. 策略生成方向信号
5. 买入执行阶段二次选标
6. 成交后写入 `OccupiedSeat`
7. 卖出与风控围绕 `OccupiedSeat`
8. 空仓后释放 `OccupiedSeat`

## 12.3 距离移仓

顺序建议固定为：

1. 发现当前 `OccupiedSeat` 超阈值
2. 确保候选池可用
3. 排除旧标的
4. 提交卖出旧标的
5. 等待旧标的空仓
6. 从候选池中选择新标的
7. 提交买入
8. 成交后切换占用席位

---

## 13. 实施顺序

本次重构必须按以下顺序落地。

## 阶段 1：先建立新状态模型

目标：

1. 新增 `CandidatePoolState`
2. 新增 `OccupiedSeatState`
3. 新增双注册表

此阶段不改交易策略，只改运行时数据模型。

## 阶段 2：重构自动寻标为候选池输出

目标：

1. `autoSymbolFinder` 返回列表
2. `candidatePoolManager` 完成刷新、抑制、冻结、踢出

## 阶段 3：重构启动恢复与订阅模型

目标：

1. 启动只恢复 `OccupiedSeat`
2. 独立刷新 `CandidatePool`
3. 新订阅集合生效

## 阶段 4：重构买入链路

目标：

1. 买入信号不再提前绑定 warrant symbol
2. 执行阶段使用 `candidateSelector`
3. 成交后正式占用席位

## 阶段 5：重构卖出、风险和刷新链路

目标：

1. 所有持仓语义全部迁到 `OccupiedSeat`
2. 所有候选语义全部迁到 `CandidatePool`

## 阶段 6：重构周期换标和距离换标

目标：

1. 周期换标只刷新候选池或等待空仓
2. 距离换标重写为“旧标的清仓 + 候选池选新标的 + 买入切换”

## 阶段 7：删除旧席位语义

目标：

1. 删除“自动寻标成功即 READY symbol”的旧路径
2. 删除旧 `switchStateMachine` 前提
3. 删除依赖 READY symbol 的旧校验和接线

---

## 14. 测试方案

## 14.1 单元测试

至少补充：

1. 候选池主层 + 降级层补足到十个
2. 候选池列表指纹完全相同触发当日抑制
3. 候选超阈值踢出与少于五个时刷新
4. `candidateSelector` 在多候选下稳定选出最优标的
5. `OccupiedSeat` 在成交后占用、空仓后释放
6. 距离移仓状态机从旧标的卖出到新标的买入闭环

## 14.2 集成测试

至少覆盖：

1. 无持仓时，候选池存在但席位不占用
2. 买入时从候选池中选出 symbol 并建立占用席位
3. 卖出清仓后释放占用席位，但候选池仍保留
4. 启动恢复时有持仓，直接恢复占用席位
5. 启动恢复时无持仓，不恢复占用席位，只刷新候选池
6. 周期换标在空仓时只刷新候选池
7. 周期换标在持仓时等待空仓后刷新
8. 距离超阈值时成功完成移仓
9. 候选池刷新与上一版完全一致后触发当日抑制

## 14.3 回归测试

必须确保以下旧语义仍正确：

1. 卖出链路与订单记录归属不漂移
2. 保护性清仓仍能按真实持仓标的执行
3. 成交后刷新仍围绕真实持仓标的执行
4. 启动恢复持仓归属不丢失

---

## 15. 验收标准

满足以下条件才算完成：

1. 自动寻标不再写入唯一 READY 席位标的。
2. 每个方向都能维护最多十个候选标的。
3. 候选标的均已订阅 `Quote + Depth + Trades`。
4. 无持仓时该方向不占用席位。
5. 买入时由候选池在执行阶段选出真实下单标的。
6. 买入成交后才占用席位。
7. 清仓且确认空仓后立即释放席位。
8. 启动恢复时有持仓则直接恢复占用席位。
9. 周期换标和距离换标都按新语义重写。
10. 候选池刷新与上一版完全一致时触发当日抑制。
11. `bun lint` 通过。
12. `bun type-check` 通过。
13. 相关测试全部通过。

---

## 16. 最终结论

本次需求不是自动寻标增强，而是交易对象生命周期的重定义。

唯一正确且最短的实现路径是：

1. 用 `CandidatePool` 取代“自动寻标直接写席位”的旧模型。
2. 用 `OccupiedSeat` 表达真实持仓归属。
3. 买入在执行瞬间从候选池选标。
4. 卖出、风控、恢复和移仓只围绕占用席位。
5. 删除旧的单席位单 symbol 前提，而不是尝试兼容它。

在这个前提下，你要的 9 条需求可以形成一套自洽模型，而且不会把系统继续锁死在“先绑定 symbol，后谈交易”的旧架构里。

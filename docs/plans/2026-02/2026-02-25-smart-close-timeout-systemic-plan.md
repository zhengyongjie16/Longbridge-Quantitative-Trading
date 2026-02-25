# 智能平仓持仓超时（三阶段）系统性重构最终方案

## 1. 目标与结论

本方案用于在现有智能平仓基础上，新增“持仓超时卖出”第三阶段，并保证：

1. 逻辑顺序严格为：
   1. 整体盈利全卖（命中即结束）
   2. 整体未盈利先卖盈利订单
   3. 再从第二阶段剩余订单中卖出超时订单
2. 持仓时长按**严格交易时间**计算（跨日也只累计实际开盘时长，不能按自然时间折算，也不能跨日立即判超时）。
3. 方案为系统性重构，不采用兼容分支或补丁式叠加。

---

## 2. 需求冻结（已确认）

以下内容作为本次改造的冻结规则：

1. 跨日订单不能直接判超时，必须严格按交易时间累计。
2. 新配置项允许 `null` 或留空，二者语义一致：关闭第三阶段。
3. 第三阶段仅从第二阶段后的剩余订单中筛选，并且受第二阶段已占用额度约束。

---

## 3. 现状审计（当前主链路）

### 3.1 卖出链路

1. `sellProcessor` 调用 `signalProcessor.processSellSignals` 进行卖量计算。
2. 智能平仓核心在 `resolveSellQuantityBySmartClose`：
   - `currentPrice > costAveragePrice` -> `includeAll=true` 全卖
   - 否则仅卖盈利订单（`buyPrice < currentPrice`）
3. 订单筛选、防重、整笔截断在 `orderStorage.getSellableOrders`。

### 3.2 时间能力

当前已有“当日已开盘分钟”工具，但超时策略尚未接入智能平仓，也未形成跨日严格累计闭环。

同时，周期换标当前采用“当日开盘分钟坐标差”近似计算（`currentTradingMinutes - readyTradingMinutes`）：

1. 该模型对同日场景有效。
2. 对跨日严格累计场景不充分。
3. 与本次“持仓超时跨日严格交易时间”目标存在口径差异。

---

## 4. 可行性与合理性分析

## 4.1 技术可行性

可行，原因如下：

1. 订单记录已具备成交时间 `executedTime`，可作为持仓起点。
2. 卖出阶段已有防重与整笔语义基础设施，可复用到第三阶段。
3. 系统已有交易日判定能力（交易日/半日市），可扩展为“跨日交易时段累计时长（毫秒）”服务。

## 4.2 业务合理性

合理，原因如下：

1. 阶段1优先保证整体盈利时快速兑现。
2. 阶段2保留原有“只卖盈利订单”的保守策略。
3. 阶段3通过时间约束释放长期滞留仓位，避免长期挂仓。
4. “阶段2先于阶段3”与需求一致，且可解释性强。

## 4.3 一致性与完整性

方案完整覆盖：配置 -> 校验 -> 卖出决策 -> 时间计算 -> 订单筛选 -> 日志 -> 测试 -> 文档。

本方案不新增“临时兼容逻辑”，而是统一替换旧卖出筛选接口，确保语义单一。

## 4.4 共用内核可行性（新增）

“持仓超时计算”与“周期换标周期计算”可以共用底层能力，但不能直接共用完整业务算法：

1. 可共用部分：
   - 交易时段累计时长内核（给定起止时间 + 交易日历，输出累计毫秒）。
2. 不可直接共用部分：
   - 业务触发门控不同（周期换标受 `canTradeNow/openProtectionActive` 约束；持仓超时属于卖出策略判定，不应直接继承该门控）。
   - 状态机语义不同（周期换标有 pending/seatVersion/席位状态迁移；持仓超时是订单筛选语义）。
3. 设计结论：
   - 采用“共用时间内核 + 独立业务层包装”的系统化分层。
4. 统一比较口径：
   - 配置仍使用分钟（便于配置）。
   - 执行层统一转换为毫秒比较，避免分钟取整歧义。

---

## 5. 系统性重构原则（非补丁）

1. **全量替换旧卖出筛选接口**：移除 `getSellableOrders(includeAll)` 的二义性入口，统一为策略化选单接口。
2. **时间计算单一来源**：所有“是否超时”由同一交易时段累计时长函数计算，不允许各模块重复实现。
3. **额度与顺序统一执行**：阶段2先占用额度，阶段3仅使用剩余额度；禁止并行独立选单后再拼接。
4. **配置语义单一**：`null` 与空值统一表示“关闭第三阶段”。
5. **共用内核 + 独立业务层**：统一复用交易时段累计时长内核；智能平仓与周期换标分别保留独立业务规则和触发条件。

---

## 6. 目标业务流程（最终）

设：

- `AQ` = 当前可用持仓数量（availableQuantity）
- `P` = 当前价
- `C` = 成本均价
- `T` = 持仓超时阈值分钟（`number | null`）
- `timeoutMs = T * 60_000`

流程：

1. 若 `C` 有效且 `P > C`：
   - 直接全卖（仍受防重、整笔、`AQ` 约束）。
2. 否则执行阶段2：
   - 先卖盈利订单，得 `Q2`。
3. 若 `T` 为 `null`：
   - 不执行阶段3，结果即阶段2。
4. 若 `T` 非 `null`：
   - 从“阶段2剩余订单”中筛超时订单，得 `Q3`。
   - 其中 `Q3 <= AQ - Q2`。
5. 最终卖量 `Q = Q2 + Q3`。
6. 若 `Q == 0`：HOLD。

超时判定：`heldTradingMs > timeoutMs`（严格大于）。
等于阈值时不触发，超过 1ms 才触发。

---

## 7. 严格交易时间模型（跨日）与共用内核

## 7.1 核心定义

`heldTradingMs = sum(overlapMs(orderTime, now, eachTradingSession))`

- 仅累计交易日的连续交易时段。
- 正常日：09:30-12:00，13:00-16:00。
- 半日市：09:30-12:00。
- 午休、收盘后、非交易日、节假日不计时。

## 7.2 跨日计算

对 `orderTime` 到 `now` 区间按香港日期切片：

1. 首日：从 `orderTime` 起累计到该日收盘（毫秒）。
2. 中间日：若为交易日，累计该日完整开盘时段（毫秒）。
3. 末日：从该日开盘累计到 `now`（毫秒）。

## 7.3 交易日来源

引入统一“交易日历快照服务”（runtime cache）：

1. 生命周期启动/开盘重建时预热覆盖区间。
2. 卖出时仅同步读取本地快照（不在卖出热路径发起临时网络请求）。
3. 快照缺口由生命周期异步补齐，不影响卖出主线程语义一致性。

## 7.4 共用时间内核边界（新增）

统一抽象一个纯函数内核（示意）：

- `calculateTradingDurationMsBetween({ startMs, endMs, calendarSnapshot }) => number`

内核职责仅包括：

1. 按交易日/半日市与交易时段累计毫秒。
2. 不感知策略类型（智能平仓/周期换标）。
3. 不包含 `canTradeNow`、`openProtectionActive`、状态机阶段等业务门控。

业务层包装：

1. 智能平仓层：基于内核输出判断订单是否超时。
2. 周期换标层：基于内核输出判断周期是否到期，并叠加现有业务门控与状态机语义。

---

## 8. 模块改造设计

## 8.1 配置域改造

### 8.1.1 新增配置项

- `SMART_CLOSE_TIMEOUT_MINUTES_N`
- 类型：`number | null`
- 取值：
  - 空值 / `null` -> `null`
  - 非负整数 -> 对应分钟值
  - 其他值 -> 校验失败

### 8.1.2 类型更新

`MonitorConfig` 新增：

- `smartCloseTimeoutMinutes: number | null`

### 8.1.3 解析与校验

1. 解析器新增专用 parse 函数（仅接受非负整数或 `null`/空）。
2. validator 对非法值直接报错，不做截断和回退。
3. 配置输出日志新增该项。

---

## 8.2 卖出决策域重构

### 8.2.1 接口重构

将 `processSellSignals` 改为对象入参，显式包含：

- `smartCloseEnabled`
- `smartCloseTimeoutMinutes`
- `nowMs`
- `isHalfDay`

不再追加散列参数，避免后续继续堆叠。

### 8.2.2 三阶段执行器

在 `resolveSellQuantityBySmartClose` 内重构为：

1. `resolveOverallProfitability`（阶段1判定）
2. `selectStage2ProfitOrders`
3. `selectStage3TimeoutOrdersFromRemainder`
4. `composeFinalSellDecision`

每个阶段职责单一，便于测试。

---

## 8.3 订单筛选域重构

### 8.3.1 替换旧接口

替换 `getSellableOrders(...)` 为策略化接口（示意）：

- `selectSellableOrders({ symbol, direction, strategy, currentPrice, timeoutMinutes, nowMs, isHalfDay, maxSellQuantity, excludeOrderIds })`

其中 `strategy`：

- `ALL`
- `PROFIT_ONLY`
- `TIMEOUT_ONLY`

### 8.3.2 统一约束

所有策略统一复用：

1. pending 占用过滤
2. 排序与整笔截断
3. `maxSellQuantity` 上限

从根层保证“同一语义，同一实现”。

---

## 8.4 时间域重构

新增交易时段累计时长模块（建议独立文件），提供：

1. `calculateHeldTradingDurationMs(params)`
2. `isOrderTimedOut(params)`

并统一由订单筛选域调用。

---

## 8.5 周期换标计时层迁移（新增）

将周期换标从“当日开盘分钟坐标差”迁移到共用内核：

1. 周期到期判断改为调用 `calculateTradingDurationMsBetween(lastSeatReadyAt, now, calendarSnapshot)`。
2. `switchIntervalMinutes` 转为 `intervalMs` 后比较，保持配置层单位为分钟。
3. 继续保留 `canTradeNow/openProtectionActive` 门控与 pending 语义（开盘保护期间不触发，但累计时长继续增长，保护结束后可立即到期触发）。
4. 不改变换标状态机阶段流转，仅替换计时数据来源。

---

## 8.6 生命周期与上下文接线

1. 在生命周期域维护“交易日历快照”状态。
2. `sellProcessor` 从 `lastState` 获取当前交易日信息与当前时间，传入 `signalProcessor`。
3. `autoSymbolManager` 的周期换标入口从相同快照读取计时依赖。
4. 所有卖出路径（含 SELLPUT/SELLCALL）统一走新接口。

---

## 8.7 日志与可观测性

新增标准化日志字段：

- `overallProfitMatched`
- `stage2Quantity`
- `stage3Quantity`
- `timeoutMinutes`
- `timedOutOrderCount`
- `remainingAfterStage2`

确保复盘能定位“为何卖/为何未卖”。

---

## 9. 关键文件改造清单

1. `src/types/config.ts`
2. `src/config/config.trading.ts`
3. `src/config/config.validator.ts`
4. `src/core/signalProcessor/types.ts`
5. `src/core/signalProcessor/sellQuantityCalculator.ts`
6. `src/core/signalProcessor/utils.ts`
7. `src/types/services.ts`
8. `src/core/orderRecorder/types.ts`
9. `src/core/orderRecorder/orderStorage.ts`
10. `src/core/orderRecorder/index.ts`
11. `src/utils/helpers/tradingTime.ts`（或新增同域工具文件）
12. `src/main/asyncProgram/sellProcessor/index.ts`
13. `src/services/autoSymbolManager/switchStateMachine.ts`
14. `src/services/autoSymbolManager/types.ts`（若新增计时依赖类型）
15. `src/types/state.ts`（若新增交易日历快照字段）
16. `.env.example`
17. `README.md`

---

## 10. 测试方案（必须全链路）

## 10.1 配置测试

1. `SMART_CLOSE_TIMEOUT_MINUTES_N` 为 `null` / 空 / `0` / 正整数。
2. 非整数、负数、非法字符串直接失败。

## 10.2 时间计算测试

1. 同日早盘。
2. 同日下午。
3. 跨午休。
4. 跨正常日。
5. 跨半日市。
6. 跨周末/非交易日。
7. 阈值边界：`heldTradingMs == timeoutMs` 不触发，`heldTradingMs == timeoutMs + 1` 触发。

## 10.3 卖出决策测试

1. 阶段1命中后阶段2/3不执行。
2. 阶段2后阶段3仅从剩余订单选。
3. 阶段3命中但受 `AQ - Q2` 限制。
4. 阶段2+3订单去重。
5. `T=null` 时第三阶段不执行。

## 10.4 集成回归

1. sell-flow 端到端：整体未盈利 + 超时触发。
2. pending 占用 + 三阶段组合。
3. SELLCALL 与 SELLPUT 对称验证。
4. 周期换标跨日累计时长验证（与历史同日行为保持一致，跨日行为修正为严格交易时段累计口径）。

---

## 11. 实施顺序（执行计划）

1. 配置类型与解析校验落地。
2. 交易时间累计模块落地（含跨日严格计时）。
3. 订单筛选接口全量替换（旧接口移除）。
4. signalProcessor 三阶段执行器落地。
5. 周期换标计时迁移到共用内核（保留独立业务层门控）。
6. sellProcessor 入参与上下文接线改造。
7. 文档更新（`.env.example`、`README`）。
8. 单元 + 集成测试补齐。
9. `bun run lint` 与 `bun run type-check` 全通过。

---

## 12. 验收标准（Done Definition）

1. 功能验收
   1. 三阶段顺序与数量约束完全符合需求冻结。
   2. 跨日订单超时判定只按交易时段累计毫秒。
   3. `null` 与空值关闭第三阶段且行为一致。
2. 代码验收
   1. 无兼容分支，无旧接口遗留调用。
   2. 时间计算单一实现，无重复逻辑。
   3. 智能平仓与周期换标共用同一时间内核，但业务层逻辑保持独立。
3. 测试验收
   1. 新增测试覆盖配置/时间/三阶段/集成场景。
   2. 全量测试、lint、type-check 通过。
4. 文档验收
   1. README 与 `.env.example` 与实现一致。

---

## 13. 非目标（明确排除）

1. 不改变买入风控链路。
2. 不改变末日保护清仓逻辑。
3. 不引入“超时后强制全部卖出”的额外策略。
4. 不保留旧卖出筛选接口作为并行兼容路径。

---

## 14. 方案结论

该方案在当前架构下可实施，且满足以下要求：

1. 业务逻辑正确：三阶段顺序、额度约束、跨日严格交易时间。
2. 工程路径完整：配置、核心算法、时间模型、调用链、测试、文档全覆盖。
3. 改造方式系统性：以接口替换和统一时间模型为核心，不走补丁兼容。

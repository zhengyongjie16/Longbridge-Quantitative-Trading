# 自动换标新增「周期换标」方案（详细版）

**日期**: 2026-02-21

**目标**: 在现有“距回收价越界触发换标”的基础上，新增可配置的“周期换标”能力，保证换标与现有席位状态机、队列清理、撤单逻辑一致，并避免与距离换标发生竞态。

**Tech Stack**: TypeScript (ES2022), bun, LongPort OpenAPI SDK, pino。

**规范约束**: 遵守 `typescript-project-specifications` 全部核心原则；方案必须系统性且完整，避免兼容性或补丁式实现。

---

## 一、已确认决策

1. 配置命名
- 环境变量使用 `SWITCH_INTERVAL_MINUTES_N`
- 代码字段使用 `AutoSearchConfig.switchIntervalMinutes`

2. 周期起点
- 只要席位进入 READY，就以“当前时刻”作为周期起点。
- 启动时席位恢复为 READY（因持仓/历史标的）也从启动时刻开始计时，不会立即换标。

3. 候选与旧标的一致
- 周期换标预寻标若返回同一标的，记录当日抑制，当天不再因周期换标触发该标的的换标。

4. 交易时段约束
- 周期换标仅在 `canTradeNow` 为真时触发。
- 到期发生在非交易时段时，将在下一次进入交易时段时再触发判断。

5. 持仓判断口径
- 仅依赖订单记录（`orderRecorder.getBuyOrdersForSymbol`）判定是否仍有持仓。
- 未成交卖出挂单不会更新订单记录，因而会自然延后周期换标，行为符合需求。

---

## 二、现状关键流程（与本需求强相关）

1. 触发机制
- 自动换标目前只由 `AUTO_SYMBOL_SWITCH_DISTANCE` 触发，条件是监控标的价格变化且距回收价越界。

2. 换标状态机
- `switchStateMachine` 负责撤单、卖出、占位、回补与完成。
- 进行中流程由 `switchStates` 持久化，任务每 tick 推进。

3. 席位与队列清理
- 换标开始时 `clearSeat()` 设置 `SWITCHING` 并 bump 版本号。
- `syncSeatState()` 监测 READY→非 READY 时清理延迟验证、买卖任务、监控任务，并清空牛熊证信息缓存。

4. 撤单逻辑
- 仅撤销该方向旧标的的“买入挂单”。
- 卖出挂单不撤销。

---

## 三、总体设计目标与原则

1. 周期换标与距离换标共用换标状态机与席位状态。
2. 周期换标仅新增“触发入口”和“等待空仓后换标”机制。
3. 不新增全新状态机，不复制流程。
4. 保证席位版本与队列清理一致性。
5. 严格避免周期换标与距离换标并发竞争。

---

## 四、配置与类型设计

### 4.1 配置字段

- 新增 `AutoSearchConfig.switchIntervalMinutes`。
- 允许范围 0-120，0 表示关闭周期换标。

### 4.2 环境变量

- 新增 `SWITCH_INTERVAL_MINUTES_N`。
- 在 `.env.example` 与 README 配置表中补充说明。

### 4.3 校验规则

1. 解析规则
- 解析时用 bounded 逻辑限制为 0-120。
- 未配置默认 0。

2. 校验规则
- 若 env 有值但解析失败则视为配置错误。
- 若解析值在边界外，按既有规则警告并截断到 0 或 120。

---

## 五、席位时间语义调整

### 5.1 新增字段

- `SeatState.lastSeatReadyAt: number | null`
- 语义为“席位最近一次进入 READY 的时间戳”。

### 5.2 写入时机

1. 自动寻标成功时
- `autoSearch.ts` 将席位置为 READY 时写入 `lastSeatReadyAt = now`。

2. 换标完成时
- `switchStateMachine.ts` 进入 COMPLETE 并更新 READY 时写入 `lastSeatReadyAt = now`。

3. 启动恢复 READY 席位时
- `startup/seat.ts` 将恢复出的 READY 席位写入 `lastSeatReadyAt = 启动时刻`。

### 5.3 不写入时机

- `clearSeat()` 进入 SWITCHING 时不修改 `lastSeatReadyAt`。
- 搜索失败、EMPTY、SEARCHING 等非 READY 状态不修改该字段。

### 5.4 跨日清理

- `seatDomain.midnightClear` 清空席位时将 `lastSeatReadyAt` 置为 null。
- 这样避免跨日旧时间戳带来误触发风险。

---

## 六、周期换标状态管理

### 6.1 新增内部状态

在 `autoSymbolManager` 侧新增方向级别 Map：

- `periodicSwitchPending: Map<'LONG'|'SHORT', { pending: boolean; pendingSinceMs: number | null }>`

用途：
- 到期但仍有持仓时，进入等待状态。
- 空仓后再触发换标。

### 6.2 清理时机

- 进入换标流程时清空 pending。
- 距离换标触发时清空 pending。
- 席位不再 READY 或标的变化时清空 pending。

---

## 七、周期换标触发逻辑（核心流程）

新增 `maybeSwitchOnInterval`（位于 `switchStateMachine` 或其外层封装），由 `AUTO_SYMBOL_TICK` 调用。

### 7.1 触发入口

- 在 `AUTO_SYMBOL_TICK` 处理函数中，完成 `maybeSearchOnTick` 后调用 `autoSymbolManager.maybeSwitchOnInterval`。
- 不新增新的监控任务类型。

### 7.2 伪流程（按方向）

1. 前置条件
- `autoSearchEnabled = true`
- `switchIntervalMinutes > 0`
- `canTradeNow = true`
- seat 状态为 READY 且 symbol 有效
- 当前无进行中换标（`hasPendingSwitch(direction) = false`）

2. 周期到期判定
- 读取 `lastSeatReadyAt`。
- 计算 `dueAt = lastSeatReadyAt + intervalMinutes * 60 * 1000`。
- `now < dueAt` 时直接返回。

3. 持仓判断
- 使用 `orderRecorder.getBuyOrdersForSymbol(symbol, isLong)`。
- 有记录则标记 pending 并返回。
- 无记录则进入换标流程。

4. 等待空仓
- 若已 pending，则每 tick 检查订单记录是否清空。
- 订单记录更新后显示为空仓时，立即触发换标流程。

5. 触发换标
- 复用距离换标的“换标启动函数”，统一入口。
- 触发原因记录为“周期换标触发”。

---

## 八、换标流程复用与统一入口

### 8.1 统一换标启动函数

将距离换标和周期换标共享同一“启动流程函数”，建议在 `switchStateMachine` 中抽取：

- `startSwitchFlow({ direction, reason, monitorPrice, quotesMap, positions })`

功能包括：
1. 预寻标候选。
2. 同标的则触发当日抑制并退出。
3. `clearSeat()` 进入 SWITCHING。
4. 初始化 `switchStates` 并调用 `processSwitchState`。

### 8.2 日内抑制共用

- 周期换标与距离换标使用同一抑制表 `switchSuppressions`。
- 任何触发发现候选等于旧标的时记录当日抑制。

---

## 九、竞态处理与互斥规则

1. 同方向互斥
- 一旦存在 `switchStates`，无论触发源，都禁止再次启动换标。

2. 距离换标优先
- 若周期处于 pending 状态且距离换标触发，直接清除 pending 并启动距离换标。

3. 席位状态防线
- `READY` 以外状态不允许周期换标，也会清除 pending。
- 通过 seatVersion 与 symbol 快照校验阻断旧任务执行。

---

## 十、队列清理与撤单一致性

1. 清理行为
- 进入 SWITCHING 时由 `syncSeatState` 触发队列清理。
- 清理内容包括延迟验证、买卖任务、监控任务。

2. 撤单行为
- `switchStateMachine` 的 `CANCEL_PENDING` 阶段仅撤销买入挂单。
- 卖出挂单不受影响。

3. 与需求对齐
- 周期换标触发后与距离换标完全一致。

---

## 十一、边界与异常情形处理

1. 到期但非交易时段
- 不触发换标，也不进入 pending。
- 等下一次交易时段进入后再判断。

2. 订单记录异常为空
- 可能导致周期换标过早触发，这是现有系统一致性风险。
- 不引入新的持仓口径以免与现有卖出/风控逻辑冲突。

3. 无候选标的
- 复用现有换标失败处理逻辑，席位进入 EMPTY 并累积失败计数或冻结。

4. 当日抑制
- 周期换标触发后如候选与旧标的一致，记录当日抑制。
- 当日内不再因周期换标触发该方向换标。

---

## 十二、涉及文件与改动清单

1. 配置与类型
- `src/types/config.ts`
- `src/config/config.trading.ts`
- `src/config/config.validator.ts`
- `.env.example`
- `README.md`

2. 席位状态与时间戳
- `src/types/seat.ts`
- `src/services/autoSymbolManager/seatStateManager.ts`
- `src/services/autoSymbolManager/autoSearch.ts`
- `src/services/autoSymbolManager/switchStateMachine.ts`
- `src/main/startup/seat.ts`
- `src/main/lifecycle/cacheDomains/seatDomain.ts`

3. 周期换标逻辑与入口
- `src/services/autoSymbolManager/types.ts`
- `src/services/autoSymbolManager/index.ts`
- `src/main/asyncProgram/monitorTaskProcessor/handlers/autoSymbol.ts`

---

## 十三、实施步骤（系统化）

1. 配置层
- 新增 `SWITCH_INTERVAL_MINUTES_N` 解析与校验。
- 更新 `.env.example` 与 README。

2. 模型层
- 扩展 `SeatState`，新增 `lastSeatReadyAt`。
- 全链路 READY 路径写入时间戳。

3. 业务逻辑层
- 增加周期换标状态与判定。
- 抽取统一换标启动函数。
- 周期换标复用换标状态机。

4. 调度与异步队列
- `AUTO_SYMBOL_TICK` 中调用 `maybeSwitchOnInterval`。
- 保持换标推进仍由 `AUTO_SYMBOL_SWITCH_DISTANCE` 驱动。

5. 验证与回归
- `bun run lint`
- `bun run type-check`
- 日志验证周期触发、等待空仓与换标推进路径。

---

## 十四、验证用例清单

1. 周期关闭
- `switchIntervalMinutes = 0` 时永不触发周期换标。

2. 周期触发无持仓
- 到期后进入换标流程。

3. 周期触发有持仓
- 到期后进入 pending，持仓清零后立即触发换标。

4. 距离换标优先
- pending 状态下发生距离换标，周期 pending 被清理，距离换标正常执行。

5. 当日抑制
- 周期换标预寻标返回同标的时，记录当日抑制并停止。

6. 非交易时段
- 到期发生在非交易时段，进入交易时段后再触发。

7. 队列清理
- 进入 SWITCHING 时清理延迟验证和买入任务，卖出挂单不撤销。

---

## 十五、风险与注意事项

1. 订单记录准确性
- 周期换标完全依赖订单记录判定是否持仓，若记录异常会影响触发时机。

2. 无候选标的
- 复用现有失败处理会导致席位进入 EMPTY，并可能触发冻结。

3. 时间戳一致性
- 必须确保所有 READY 路径写入 `lastSeatReadyAt`，否则周期判定可能异常。

---

**结论**: 该方案在不破坏现有自动换标体系的前提下，新增周期换标触发、等待空仓后换标机制，并严格复用既有状态机、撤单与队列清理逻辑，满足所有已确认需求与竞态约束。

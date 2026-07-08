# HSI 延迟信号缺失问题修复方案

## 1. 问题摘要

本方案针对如下已复核问题：

- `2026-04-22 13:06:09`，`HSI.HK` 的监控指标满足 BUYCALL 条件；
- 但系统没有为 HSI 对应做多标的创建 delayed signal。

对日志与代码的复核已经确认两件事：

1. **这不是 delayed verifier 本身的判断问题。**
2. **已经证实的结果是：HSI 在 `10:45` 周期换标后，没有处于后续普通信号生成所要求的 `ACTIVE` 席位状态，因此到 `13:06` 即使监控指标满足 BUYCALL，普通信号链路也不会创建 delayed signal。**

当前最强根因假设是：

- 周期换标后的 seat 恢复链路与队列清理链路发生冲突；
- 恢复该 seat 所必需的 `SEAT_REFRESH` monitor task 很可能在 ACTIVE 退化后的方向性清理阶段被误删；
- 但在补足 `SEAT_REFRESH scheduled / removed / skipped / processed` 直接日志前，这一点仍应保持为高概率根因，而不是已证实事实。

补充样本边界：

- **HSI 之所以受影响，是因为它在 `10:45` 真实进入了周期换标链路。**
- **9988.HK 当时没有受影响，是因为它只是“预寻标命中同标的，记录当日抑制”，并没有真正进入 `SWITCHING/ACTIVATING`。**

因此，本方案修复的不是“某个 monitor 的偶发 bug”，而是：

**所有真实进入 seat phase 切换链路的 monitor 都可能触发的恢复任务清理边界错误。**

## 2. 本文档与 findings 文档的关系

相关问题分析文档：

- `docs/issues/2026-04/2026-04-22-hsi-delayed-signal-missing-seat-refresh-cleanup-conflict-findings.md`

两份文档的职责边界如下：

1. `findings` 文档负责记录：
   - 问题现象
   - 日志证据
   - 代码级根因分析
   - 已证实事实与高概率根因的边界
2. 本 `remediation plan` 文档负责记录：
   - 在上述复核基础上可执行的最短路径修复方案
   - 修复边界
   - 不采用的方案
   - 回归验证要求

也就是说：

- 本文档现在已经补足了独立阅读所需的问题摘要与修复前提；
- 但若需要查看完整原始证据链，仍应回看 `findings` 文档。

## 3. 方案目标

本方案用于修复 `2026-04-22` 发现的 HSI 周期换标后延迟信号缺失问题。

目标只有三个：

1. 保证周期换标或其他 seat phase 退化后，席位恢复所必需的 `SEAT_REFRESH` 不会被错误清理。
2. 保持当前事件驱动 seat 恢复模型不变，不引入兜底、回退、兼容双轨或补丁式状态机。
3. 用回归测试和运行态日志把问题闭环钉住，确保后续可以直接证明恢复链路是否工作正常。

本方案不是要重做整套 monitor task 架构，也不是要增加新的恢复分支；而是修正当前**错误的任务清理边界**。

---

## 4. 已确认的事实

本方案建立在以下已确认事实之上：

1. 普通信号生成只接受 `ACTIVE` 席位。见：
   - `src/utils/utils.ts:14-49`
   - `src/core/strategy/index.ts:281-354`
2. `processMonitor` 当前顺序是：
   - 先 `scheduleAutoSymbolTasks(...)`
   - 后 `syncSeatState(...)` 见：`src/main/processMonitor/index.ts:44-59`
3. seat 从 `ACTIVE` 退化为非 `ACTIVE` 时，会触发方向性清理。见：
   - `src/main/processMonitor/seatSync.ts:90-106`
4. 方向性清理当前会删除该方向所有 monitor tasks。见：
   - `src/main/processMonitor/utils.ts:77-99`
5. `SEAT_REFRESH` 当前是带 `direction` 的 monitor task，因此满足这条清理规则。见：
   - `src/main/seatActivationDispatcher/index.ts:47-60`
   - `src/main/asyncProgram/monitorTaskProcessor/types.ts:41-49`
6. `SEAT_REFRESH` 是 seat 从 `ACTIVATING` 推进到 `ACTIVE` 的恢复屏障。见：
   - `src/main/asyncProgram/monitorTaskProcessor/handlers/seatRefresh.ts:121-243`

因此，本问题的修复点应当直接落在：

**ACTIVE 退化时对 monitor tasks 的清理边界。**

---

## 5. 修复目标不变量

修复完成后，系统必须满足以下不变量：

1. `SEAT_REFRESH` 只能被 seat version / symbol 校验自然淘汰，不能被 ACTIVE 退化清理直接误删。
2. `AUTO_SYMBOL_TICK`、普通监控任务、延迟验证任务、买卖任务仍然按现有清理语义正常工作。
3. seat 从 `ACTIVATING` 推进到 `ACTIVE` 仍然只能通过现有 `SEAT_REFRESH` 屏障完成。
4. 不新增“如果 seat 没恢复就再补一次刷新”之类的补偿式兜底逻辑。
5. 不引入第二套 seat 恢复 owner，不制造双真相。

---

## 6. 不采用的方案

### 6.1 不采用“新增兜底重试恢复”

不采用。原因：

1. 当前问题不是恢复缺少重试，而是恢复任务边界错误。
2. 额外加重试会掩盖真正的任务清理错误。
3. 这属于补丁式修复，会让 seat 恢复链路变成双轨语义。

### 6.2 不采用“保留现状，只补日志观察”

不采用。原因：

1. 只补日志不能修复真实问题。
2. 当前已经可以从代码证明 monitor task 清理边界是错误的。

### 6.3 不采用“立即重构 monitor task 体系分层”

当前不作为首选。原因：

1. 这会扩大改动面。
2. 当前问题已经可以通过更短路径修复。
3. 在最小修复尚未验证前，先做任务体系重构属于过度设计。

后续若最小修复仍暴露更深层任务语义问题，再单独立项。

---

## 7. 最终修复方案

## 7.1 直接修正 `clearMonitorDirectionQueues()` 的 monitor task 清理边界

核心变更：

- 当前 `clearMonitorDirectionQueues()` 删除 monitor tasks 时，不能再把 `SEAT_REFRESH` 视为普通方向性可清理任务。

当前逻辑：

- 只要 `task.data.direction === direction`，就会被清掉。

修复后逻辑：

- 保留对普通方向性 monitor tasks 的清理；
- 明确排除 `task.type === 'SEAT_REFRESH'`；
- 让 `SEAT_REFRESH` 保留到 monitorTaskProcessor 执行时，由：
  - seatVersion 校验
  - status / symbol 校验自然决定是否 `processed` 或 `skipped`。

这样做的好处：

1. 不改变 `SEAT_REFRESH` 的 owner 和职责；
2. 不改变 `ACTIVATING -> ACTIVE` 的事件驱动模型；
3. 不需要新增任何 fallback；
4. 直接修正当前错误边界，属于最短路径。

## 7.2 保持 `SEAT_REFRESH` 的现有失效方式

本方案不改变 `SEAT_REFRESH` 的失效机制：

- 若 seatVersion 不匹配，`resolveActivatingSeatSnapshot()` 返回 `null`，任务 `skipped`
- 若当前状态不是 `ACTIVATING` 或 symbol 不一致，也 `skipped`

见：

- `src/main/asyncProgram/monitorTaskProcessor/handlers/seatRefresh.ts:104-118`
- `src/main/asyncProgram/monitorTaskProcessor/handlers/seatRefresh.ts:131-134`

也就是说：

- 不靠“预先清理”阻断旧恢复任务；
- 仍靠现有状态一致性校验阻断旧任务。

这是当前体系内更正确的边界。

## 7.3 不修改 seat 状态机语义

本次不改变以下语义：

1. `SWITCHING`
2. `ACTIVATING`
3. `ACTIVE`
4. `SeatActivationDispatcher` 监听 `ACTIVATING` 并调度 `SEAT_REFRESH`
5. `SEAT_REFRESH` 完成后推进 `ACTIVE`

因为当前问题不是状态机缺少阶段，而是：

**恢复任务还没执行就被错误清掉。**

---

## 8. 需要同步补充的验证

### 8.1 回归测试

至少补以下测试：

1. **方向性清理不会删除 `SEAT_REFRESH`**
   - 构造 seat 从 `ACTIVE -> ACTIVATING`
   - 队列中已有同方向 `SEAT_REFRESH`
   - 调用清理后，`SEAT_REFRESH` 仍存在

2. **周期换标后 seat 能恢复到 `ACTIVE`**
   - 复现：周期换标命中新标的
   - 进入 `ACTIVATING`
   - `SEAT_REFRESH` 执行成功
   - 断言最终 seat.status === `ACTIVE`

3. **ACTIVE 恢复后普通信号可再次生成**
   - 构造 monitor 指标满足 BUYCALL
   - seat 为 `ACTIVE`
   - 断言生成 delayed signal

4. **旧的 `SEAT_REFRESH` 仍可被 seatVersion 校验安全跳过**
   - 不允许因为排除清理后引入旧任务误执行

### 8.2 运行态日志

至少补以下日志点：

1. `SEAT_REFRESH scheduled`
2. `SEAT_REFRESH removed`（若未来仍有显式移除路径）
3. `SEAT_REFRESH skipped`
4. `SEAT_REFRESH processed`

这些日志的目的不是兜底，而是把“恢复链路是否闭合”变成可直接验证的事实。

---

## 9. 预期结果

修复完成后，预期链路应收敛为：

1. 周期换标触发
2. seat 进入 `SWITCHING`
3. 状态机完成后进入 `ACTIVATING`
4. `SeatActivationDispatcher` 调度 `SEAT_REFRESH`
5. ACTIVE 退化清理不会误删 `SEAT_REFRESH`
6. `SEAT_REFRESH` 完成 quote admission / 订单刷新 / 风控缓存初始化
7. seat 推进到 `ACTIVE`
8. 后续若 monitor 指标满足 BUYCALL，则正常创建 delayed signal

---

## 10. 一句话结论

本次问题的正确修复不是增加新的恢复兜底，而是：

**直接修正 `clearMonitorDirectionQueues()` 对 `SEAT_REFRESH` 的错误清理边界，保留现有事件驱动 seat 恢复模型不变。**

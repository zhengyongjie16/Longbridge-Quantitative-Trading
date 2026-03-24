# 周期换标无候选分支语义校正与系统性修复方案

## 1. 结论先行

对当前代码与历史方案文档再次复核后，结论需要校正：

1. **当前代码在周期换标无候选时，会清空席位。**
2. **这一结果与现有业务口径是一致的。**
3. 当前真正的问题，不是“清空席位这个结果错了”，而是：
   - 代码把“周期换标无候选”这种**正常业务分支**实现成了“状态机失败”；
   - 导致日志表现为 `ERROR + MISSING_NEXT_SYMBOL_ON_BIND`；
   - 让正常业务语义与真正异常语义混在一起，增加误判和排障成本。

因此，本次修复目标应调整为：

- **保留“周期换标无候选 -> 清空席位 -> 累积失败计数/冻结 -> 后续由 auto search tick 接管”这一业务结果**
- **但把它从“状态机失败收口”改造成“入口显式业务分支”**

但这里的修复边界也必须明确：

- **本次只修“周期换标无候选”的表达语义**
- **不把“距离换标无候选”一起改造成入口直接清席位**

原因是距离换标与周期换标的业务目标不同：

- 周期换标本质是“空仓后替换标的”，不承担旧标的风险退出职责；
- 距离换标本质是“风险越界后移仓”，当前链路包含撤旧买单、必要时卖出旧标的、再尝试绑定新标的；
- 若把距离无候选也前移成入口直接 `EMPTY`，会跳过既有 `SELL_OUT` / `availableQuantity=0` 等待语义，造成新的业务偏移。

因此，正确方案应是：**仅把周期无候选从状态机失败链路中剥离；距离无候选保持现有状态机语义不变。**

---

## 2. 当前代码事实复核

### 2.1 当前代码在周期换标无候选时会清空席位

当前 `startSwitchFlow(...)` 中，周期换标与距离换标共用同一预寻标与状态机启动逻辑：

- 预寻标结果写入 `nextSymbol: next?.symbol ?? null`
- 然后统一创建 `SwitchState`

见：

- `src/services/autoSymbolManager/switchStateMachine.ts:413`

后续周期换标由于不会走卖出/回补路径，会直接在 `CANCEL_PENDING` 结束后进入 `BIND_NEW`。如果 `nextSymbol` 为 `null`，则触发：

- `failAndClear('MISSING_NEXT_SYMBOL_ON_BIND')`

见：

- `src/services/autoSymbolManager/switchStateMachine.ts:660`

而 `failAndClear(...)` 在 `state.nextSymbol === null` 时会：

1. 将席位设为 `EMPTY`
2. 更新 `lastSearchAt`
3. 累积 `searchFailCountToday`
4. 达上限时冻结

见：

- `src/services/autoSymbolManager/switchStateMachine.ts:470`
- `src/services/autoSymbolManager/switchStateMachine.ts:480`

所以，**当前真实行为不是“保留旧席位”，而是“清空席位并进入失败计数/冻结链路”**。

### 2.2 日志已验证当前行为

`2026-03-23 10:45` 的日志链路与代码完全一致：

1. `9988.HK SHORT` 周期换标预寻标无候选
2. 仍进入换标中状态
3. 在 `BIND_NEW` 阶段报 `MISSING_NEXT_SYMBOL_ON_BIND`
4. 随后空席位自动寻标继续失败
5. 最终达到冻结阈值

这说明当前代码不是偶发实现，而是确实按这条链路在运行。

---

## 3. 当前业务口径复核

你补充的业务要求是：

> 找不到符合条件的标的意味着所有标的都不合条件，包括当前正在席位上的标的，这不能用于进行交易。

按这个口径，周期换标无候选时的正确业务结果应当是：

1. 当前席位标的也视为不再满足可交易条件
2. 不能继续保留 `ACTIVE + oldSymbol`
3. 应主动退出当前席位
4. 后续等待 auto search 恢复候选，或在失败达上限后冻结

这与当前代码的**最终结果**是一致的。

### 3.1 历史方案文档也支持这一点

周期换标原始方案文档明确写过：

- 无候选标的：复用现有换标失败处理逻辑，席位进入 `EMPTY` 并累积失败计数或冻结

见：

- `docs/plans/2026-02/2026-02-21-periodic-auto-switch-plan.md:299`
- `docs/plans/2026-02/2026-02-21-periodic-auto-switch-plan.md:301`

因此，这不是“当前代码偏离原方案”，而是：

- 当前代码结果与原方案一致
- 我上一版文档对业务语义的判断是错误的，现需正式更正

---

## 4. 真正需要修复的问题

本问题真正要修的不是：

- “周期无候选时是否清席位”

而是：

- “周期无候选时为何以状态机失败的形式表达”

### 4.1 现状的问题本质

当前实现把下面两类语义错误混合了：

1. **正常业务分支**
   - 周期换标到期
   - 本地空仓
   - 预寻标无候选
   - 业务上应退出当前席位

2. **真正程序异常 / 不变量破坏**
   - 状态机推进时出现不该发生的非法状态
   - 例如合法 switch 已启动，但运行时内部字段缺失

现在这两者都通过：

- `MISSING_NEXT_SYMBOL_ON_BIND`
- `ERROR`
- `状态机失败并清席位`

来表达，语义是错位的。

### 4.2 这种错位带来的实际问题

1. 运维和排障会把“正常业务无候选”误判为程序 bug。
2. 真正的状态机异常会被淹没在“无候选”的错误日志里。
3. 代码结构上允许**周期换标**把 `nextSymbol = null` 带入主状态机，这与周期分支“不做卖出/回补、仅做替换”的业务语义不匹配。
4. 周期无候选当前复用了与距离失败路径同一套收口表达，业务语义不透明。

所以，本次修复仍然是必要的，但修复目标必须改正。

---

## 5. 系统性修复目标

本次修复完成后，必须满足：

1. 周期换标无候选时，**仍然清空席位**
2. 周期换标无候选时，**仍然累积失败计数/冻结**
3. 周期换标无候选后，**仍然由 auto search tick 接管**
4. 但该链路不再通过 `BIND_NEW -> MISSING_NEXT_SYMBOL_ON_BIND -> failAndClear(...)` 间接实现
5. 距离换标无候选时，**仍保持现有 distance switch state machine 语义**
6. “周期无候选”与“真正状态机异常”必须在日志和代码结构上明确分离

---

## 6. 不采用的方案

### 6.1 不采用“保留当前实现，只改日志文案”

不采用。原因：

1. 这只是在日志层掩盖问题。
2. 周期无候选仍依赖“空候选进入状态机后再失败”的表达方式。
3. 结构性问题没有解决。

### 6.2 不采用“周期无候选保留旧席位”

不采用。原因：

1. 与当前业务要求冲突。
2. 与原始周期换标方案文档冲突。
3. 会让“不满足筛选条件的旧标的”继续被当作可交易席位使用。

### 6.3 不采用“给周期无候选单独加 suppression 或局部 cooldown”

不采用。原因：

1. 当前正确业务结果已经是 `EMPTY + auto search cooldown`。
2. 再额外叠加一层周期专用 suppression/cooldown 属于补丁式修复。
3. 会和现有空席位 auto search 的失败/冻结机制形成双轨语义。

---

## 7. 最终方案

## 7.1 只在周期分支前移“无候选”判定，不扩大到距离分支

最终方案必须收敛为：

1. `startSwitchFlow(...)` 主体结构可以继续保留
2. 仅在 `switchMode === 'PERIODIC'` 时，在 `enterSwitchingSeat(...)` 之前增加一个显式 `next === null` 分支
3. `switchMode === 'DISTANCE'` 时，继续保留当前 `nextSymbol = null` 进入状态机后的既有收口链路

这样做的原因是：

1. 周期换标不承担旧标的风险退出职责，本来就不走 `SELL_OUT` / `REBUY`
2. 距离换标当前明确承担“风险越界后的移仓”职责，`CANCEL_PENDING -> SELL_OUT -> BIND_NEW` 是业务链路本身的一部分
3. 若把距离无候选也改成入口直接清席位，会跳过现有：
   - 旧标的移仓卖出
   - `availableQuantity = 0` 时继续等待
   - 仅在真实卖出金额可计算时才决定回补
4. 这些都是当前距离换标的正式业务语义，不能被本次修复带偏

## 7.2 周期换标无候选改为入口显式业务收口

在当前 `startSwitchFlow(...)` 中，周期分支应调整为：

1. 先完成现有席位快照校验
2. 先完成现有 periodic local block recheck
3. 若 `next?.symbol === latestSeatState.symbol`
   - 继续沿用现有 `PERIODIC` suppression 语义
   - 保持原席位并返回
4. 若 `switchMode === 'PERIODIC' && next === null`
   - 直接走“周期无候选业务收口”
   - 不进入 `SWITCHING`
   - 不创建 `SwitchState`
   - 不依赖 `BIND_NEW` 再失败一次
5. 只有 `switchMode === 'PERIODIC' && next !== null` 时
   - 才进入现有 `enterSwitchingSeat(...)`
   - 才创建 `SwitchState`

这里“周期无候选业务收口”不能只是把当前 `failAndClear(...)` 挪到入口层，而必须显式保留当前运行时已经具备的外部语义。至少必须保持：

1. **清空席位时仍提升 `seatVersion`**
   - 当前运行时虽然是通过“先 `enterSwitchingSeat`、后 `EMPTY`”实现，但外部可观察结果已经包含一次版本递增；
   - 新方案前移到周期入口层后，必须显式保留这一点，不能退化成“清席位但版本不变”。
2. **写入本次退出时刻**
   - `lastSwitchAt` 应记录本次业务性退出时间；
   - `lastSearchAt` 应记录本次无候选判定时间；
   - 不能因为跳过 `SWITCHING` 而把这两个时间戳保留成旧值。
3. **保持 EMPTY 席位字段语义**
   - `symbol = null`
   - `status = 'EMPTY'`
   - `callPrice = null`
   - `lastSeatActivatedAt` 保留原值
4. **复用现有失败计数/冻结规则**
   - `searchFailCountToday` 递增
   - 达阈值时写入 `frozenTradingDayKey`
5. **清理周期 pending**
   - 若当前方向存在 `periodicSwitchPending`，在业务性清席位时必须一并清除；
   - 不能把过期 pending 留到下一次 tick 才被动清掉。

这里更合适的是一个**周期专用**业务 helper，例如：

```ts
clearSeatOnPeriodicNoCandidate({
  direction,
  oldSymbol,
});
```

它与 `failAndClear(...)` 的区别是：

1. 这是正常业务分支，不是状态机失败
2. 日志级别应明确体现“业务无候选退出”，而不是“程序失败”
3. 仍然复用现有失败计数/冻结规则

## 7.3 距离换标无候选保持现状，不纳入本次修复

本次方案必须明确写死以下边界：

1. 距离换标 `same-symbol` 语义保持不变
2. 距离换标 `no-candidate` 语义保持不变
3. 距离换标中的：
   - `SELL_OUT`
   - `availableQuantity = 0` 等待
   - `sellNotional` / `REBUY`
   - 最终失败回 `EMPTY` 都继续沿用现有状态机链路
4. 若后续要把距离换标无候选也从失败链路中剥离，必须单独立项，并先重新论证“旧标的风险退出”语义，不能在本方案中顺手改掉

## 7.4 保留现有失败计数与冻结模型，不新建第二套周期运行态

这次和上一版错误方案最大的区别是：

- **不再为周期无候选额外建模一套“完整周期后再试”的周期专用运行态**

原因：

1. 你已明确业务要求是“无候选意味着当前席位也不可交易”
2. 当前正确收口就是清席位
3. 清席位后系统天然进入现有：
   - `EMPTY`
   - `autoSearch` 冷却
   - `searchFailCountToday`
   - `frozenTradingDayKey`

这条链路已经是系统正式的“无候选后重试”模型

因此，若再额外引入周期专用 `NO_CANDIDATE` 运行态，反而会变成冗余设计。

本次最终方案要求：

- **统一复用现有空席位 auto search 重试模型**
- **但通过入口显式分支表达业务语义**

---

## 8. 日志语义修正要求

修复后日志必须区分两类事件：

### 8.1 周期无候选正常业务分支

建议新增或替换为：

```text
[自动换标] 周期换标无候选，清空席位 monitorSymbol=... direction=... oldSymbol=...
```

这类日志不应再用 `MISSING_NEXT_SYMBOL_ON_BIND` 表达。

### 8.2 真正程序异常

只有真正违反状态机内部不变量时，才继续使用：

```text
[自动换标] 状态机失败并清席位 ...
```

这样排障才有意义。

---

## 9. 代码改动范围

## 9.1 必改文件

1. `src/services/autoSymbolManager/switchStateMachine.ts`
2. `tests/services/autoSymbolManager/periodicSwitch.business.test.ts`
3. `tests/services/autoSymbolManager/switchStateMachine.business.test.ts`
4. `tests/integration/periodic-auto-symbol-chain.integration.test.ts`

## 9.2 `switchStateMachine.ts` 修改点

1. 在 `startSwitchFlow(...)` 中，只对 `switchMode === 'PERIODIC' && next === null` 增加前置业务收口
2. 新增周期专用业务 helper，例如 `clearSeatOnPeriodicNoCandidate(...)`
3. 保留现有：
   - same-symbol suppression
   - local blocked pending
   - autoSearch 失败计数与冻结规则
   - distance 无候选失败链路
4. 在周期业务性清席位 helper 中显式保持以下语义：
   - `seatVersion` 递增
   - `lastSwitchAt` / `lastSearchAt` 写当前时间
   - `symbol = null` / `status = 'EMPTY'` / `callPrice = null`
   - `lastSeatActivatedAt` 保留原值
   - `periodicSwitchPending` 清空

## 9.3 非必改文件

1. `types.ts`
   - 只有在你最终确实抽出了跨文件复用的新类型时才需要改
   - 若 helper 和分支保持在 `switchStateMachine.ts` 内部，则不应为此扩张公共类型面
2. `index.ts`
   - 只有在依赖注入接口发生变化时才需要改
   - 若仅在 `switchStateMachine.ts` 内部重排周期分支，则这里不是必改文件

---

## 10. 测试方案

## 10.1 必补业务测试

### 场景 1：周期换标到期且无候选

断言：

1. 不进入 `SWITCHING`
2. 不创建 pending switch
3. seat 直接变为 `EMPTY`
4. `searchFailCountToday` 增加
5. 达阈值时触发冻结
6. `seatVersion` 相比触发前递增
7. `lastSwitchAt` 与 `lastSearchAt` 被更新为本次退出时间
8. `periodicSwitchPending` 被清空

### 场景 2：周期换标 same-symbol

断言：

1. seat 保持 `ACTIVE`
2. 写 `PERIODIC` suppression
3. 不进入 `EMPTY`

### 场景 3：距离换标无候选

断言：

1. 保持现有 distance switch state machine 语义不变
2. 若旧标的有可用持仓，仍会先走 `SELL_OUT`
3. 若旧标的总持仓大于零但可用持仓为零，仍继续等待
4. 最终失败回 `EMPTY` 的现有行为不变
5. 本次修复不改变其日志和状态机表达

### 场景 4：主状态机不再接收空候选

断言：

1. 周期换标正常业务路径下，不再通过 `nextSymbol = null` 进入 `BIND_NEW`
2. 周期无候选不再命中 `MISSING_NEXT_SYMBOL_ON_BIND`
3. 距离无候选相关现有失败路径保持不变

## 10.2 必补集成测试

### 场景 5：完整任务链路下周期无候选

断言：

1. 周期到期
2. 预寻标无候选
3. seat 转 `EMPTY`
4. 随后由 auto search tick 按现有冷却节奏接管
5. 不再出现“状态机失败并清席位”这种误导性错误日志语义
6. 旧 tick/旧席位快照不会继续推进该方向的换标流程

---

## 11. 验收标准

修复完成后，必须满足：

1. 周期换标无候选时，业务结果仍为清空席位
2. 周期换标无候选后，失败计数与冻结语义不变
3. 距离换标无候选后，既有失败语义不变
4. 周期无候选不再产出：
   - `MISSING_NEXT_SYMBOL_ON_BIND`
   - `状态机失败并清席位`
5. 不引入距离换标卖旧/等待语义的退化
6. 入口前移后，`seatVersion`、`lastSwitchAt`、`lastSearchAt` 与 `periodicSwitchPending` 的外部可观察语义不退化

---

## 12. 最终结论

这次问题要纠正的不是业务结果，而是表达方式。

**当前代码事实**：

- 周期换标无候选时，会清空席位；
- 这与当前业务要求一致。

**当前代码缺陷**：

- 它把这个正常业务分支实现成了“状态机失败”。

所以最终修复应是：

1. 保留 `EMPTY + 失败计数/冻结 + auto search tick` 的业务结果
2. 只把“周期无候选”从状态机失败链路中剥离为入口显式业务分支
3. 保持距离换标无候选的既有状态机语义不变

这才是本问题在当前业务口径下正确、系统且完整的修复方向。

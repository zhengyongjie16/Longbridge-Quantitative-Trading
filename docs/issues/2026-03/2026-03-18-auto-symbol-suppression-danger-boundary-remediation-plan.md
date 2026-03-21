# 自动换标当日抑制误吞危险边界重试问题最终修复方案（当前代码适配版）

## 1. 文档目标

本文档用于对“自动寻标开启后，距离换标在 same-symbol 预寻标命中后写入当日抑制，导致后续危险边界触发无法再次进入预寻标/换标决策链路”的问题进行最终复核，并给出一份**面向当前代码现状、可直接实施、全链路自洽**的最终修复方案。

本文档基于当前仓库代码现状重新整理，适用于尚未开始修复前的最终设计确认。

本方案必须同时满足以下目标：

1. 不采用兼容性补丁，不保留“统一 suppression 再到调用点做例外判断”的旧模型。
2. 不改变现有距离换标与周期换标的主状态机框架，只修正**触发语义建模、suppression 建模和入口判定顺序**。
3. 修复后必须保证：
   - `PERIODIC` 触发仍可在 same-symbol 命中后做当日抑制；
   - 距离换标中的**安全侧越界**仍可在 same-symbol 命中后做当日抑制；
   - 距离换标中的**危险侧越界**绝不能被历史 suppression 吃掉；
   - `PERIODIC` 与 `DISTANCE_SAFE_SIDE` 的 suppression 能在同一方向、同一 symbol、同一交易日内并存，且互不覆盖；
   - 危险侧重复尝试失败后，仍继续复用现有 `EMPTY + auto search tick` 的失败重试链路；
   - 周期换标 pending / blockedBy 语义保持正确，不因本次修复被破坏。

---

## 2. 当前代码现状复核

本节仅用于锁定当前问题的真实落点，避免基于过时认知制定方案。

### 2.1 当前 suppression 仍是“按 symbol 的统一日内抑制”

当前代码中：

- `src/services/autoSymbolManager/types.ts`
  - `SwitchSuppression` 仍仅包含 `symbol` 与 `dateKey`
  - `SeatStateManager.resolveSuppression` / `markSuppression` 仍然只接受 `(direction, seatSymbol)`
- `src/services/autoSymbolManager/seatStateManager.ts`
  - suppression 命中条件仍是：同方向、同 symbol、同 HK 交易日
  - 没有任何 trigger kind 维度

这说明当前系统表达的是：

- “这个方向这个 symbol 今天已经被抑制过”

而不是：

- “这个方向这个 symbol 今天在某类触发语义下已被抑制过”

因此，当前 suppression 模型无法表达以下关键业务语义：

1. `PERIODIC` 与 `DISTANCE_SAFE_SIDE` 是两种不同的可抑制触发；
2. `DISTANCE_DANGER_SIDE` 根本不应进入 suppression 模型；
3. 同一 symbol 同日内，不同 suppressible trigger 应可并存而不是互相覆盖。

### 2.2 当前距离换标入口仍然把两侧越界折叠成同一种触发

当前 `src/services/autoSymbolManager/switchStateMachine.ts` 中，`maybeSwitchOnDistance(...)` 仍使用：

- `distancePercent <= range.min`
- 或 `distancePercent >= range.max`

统一视为“距回收价阈值越界”，然后以同一个 `switchMode: 'DISTANCE'` 进入 `startSwitchFlow(...)`。

这意味着当前实现仍然没有显式保留：

- `DISTANCE_SAFE_SIDE`
- `DISTANCE_DANGER_SIDE`

两类触发语义。

### 2.3 当前入口会在预寻标前先做统一 suppression 拦截

当前 `startSwitchFlow(...)` 的关键顺序仍是：

1. 判断是否已有 pending switch；
2. 判断席位是否 active；
3. 读取当前 symbol；
4. 直接调用 `resolveSuppression(direction, seatSymbol)`；
5. 命中则直接 return；
6. 否则才进入预寻标。

这意味着一旦某方向某 symbol 在同日被写下 suppression，当日后续所有该 symbol 的换标触发都会在入口被吞掉，入口没有机会根据“本次到底是 safe-side 还是 danger-side”做差异化处理。

### 2.4 当前 same-symbol 命中仍统一写 suppression

当前 `startSwitchFlow(...)` 在预寻标后如果发现：

- `next?.symbol === latestSeatState.symbol`

则会统一：

- `markSuppression(direction, latestSeatState.symbol)`

并直接结束本次触发。

因此当前 same-symbol 命中行为仍然没有区分：

1. `PERIODIC`
2. `DISTANCE_SAFE_SIDE`
3. `DISTANCE_DANGER_SIDE`

这正是“危险侧升级后仍然被当日 suppression 吞掉”的直接根因。

### 2.5 当前代码新增了 periodic pending / blockedBy 语义，修复时必须纳入分析

相较于旧版本方案，当前代码已经存在：

- `PeriodicSwitchPendingState`
- `ORDER_RECORDER` / `LOCAL_PENDING_ORDER` 两类 `blockedBy`
- `maybeSwitchOnInterval(...)` 中的周期 pending 等待与恢复逻辑
- `startSwitchFlow(...)` 中对周期触发前的本地占用复核

因此最终方案除了修复 suppression 语义外，还必须保证：

- danger-side 不可抑制不会误清 periodic pending；
- same-symbol 返回路径不会破坏既有 pending 等待语义；
- 距离换标真正接管时，仍按当前逻辑清掉 periodic pending。

---

## 3. 根因结论

本问题的根因不是单个条件缺失，而是三层建模错误共同叠加：

1. **suppression 建模错误**：当前 suppression 只按 symbol 记，不按触发语义记；
2. **distance 触发语义丢失**：当前距离换标入口没有区分 safe-side 与 danger-side；
3. **入口判定过早且过粗**：当前 `startSwitchFlow(...)` 在预寻标前用“统一日内 suppression”直接拦截后续所有触发。

因此本问题必须通过**重构触发语义 -> suppression 模型 -> 状态机入口判定链路**来修，不能通过额外 if 补丁修复。

---

## 4. 修复后必须恢复的业务不变量

### 4.1 suppression 必须表达“哪类触发被抑制”

修复后 suppression 的业务含义必须从：

- “这个 symbol 今天被抑制过”

改成：

- “这个 symbol 今天在某些**允许抑制的 trigger kind** 下被抑制过”

### 4.2 可被当日抑制的触发只有两类

只允许以下两类触发进入 suppression 模型：

1. `PERIODIC`
2. `DISTANCE_SAFE_SIDE`

### 4.3 danger-side 永远不可被当日 suppression 吞掉

`DISTANCE_DANGER_SIDE` 必须满足：

1. 不能因为之前的 `PERIODIC` suppression 被吞掉；
2. 不能因为之前的 `DISTANCE_SAFE_SIDE` suppression 被吞掉；
3. same-symbol 命中时也不能写入 suppression；
4. 在**不存在进行中的 switch、席位仍为 active、且距离换标任务本身被调度执行**的前提下，danger-side 不得被 suppression 拦截，必须允许重新进入预寻标。

### 4.4 `PERIODIC` 与 `DISTANCE_SAFE_SIDE` 可同日并存

在同一方向、同一 symbol、同一交易日内：

- `PERIODIC`
- `DISTANCE_SAFE_SIDE`

两类 suppression 必须能同时存在，不得相互覆盖。

### 4.5 LONG / SHORT 的危险侧定义必须由代码显式表达

修复后禁止再依赖注释或人脑记忆判断危险侧，必须由单一函数统一表达：

- LONG / BULL
  - `distancePercent <= range.min` => `DISTANCE_DANGER_SIDE`
  - `distancePercent >= range.max` => `DISTANCE_SAFE_SIDE`
- SHORT / BEAR
  - `distancePercent >= range.max` => `DISTANCE_DANGER_SIDE`
  - `distancePercent <= range.min` => `DISTANCE_SAFE_SIDE`

### 4.6 失败链路保持不变

本次修复只修正入口语义，不改变以下既有业务语义：

1. 距离换标真正启动后若最终找不到新候选，仍走现有失败处理；
2. 失败后席位仍落回 `EMPTY`；
3. 后续继续由 auto search tick 承接重试；
4. 周期换标仍维持现有 pending / blockedBy / 空仓后触发逻辑。

---

## 5. 不采用的方案

### 5.1 不采用“保留旧 suppression 结构，再在调用点加例外判断”

不采用。原因：

1. 旧 suppression 结构本身无法表达触发语义；
2. 后续只会继续堆叠 if；
3. 这属于典型补丁式修复，不符合本项目要求。

### 5.2 不采用“danger-side 也写 suppression，但读取时忽略”

不采用。原因：

1. 这会留下错误语义的数据；
2. 会让后续调用者继续误用；
3. danger-side 的正确做法是**根本不进入 suppression 模型**。

### 5.3 不采用“统一 suppression，但缩短 suppression 时长”

不采用。原因：

1. 当前问题不是 suppression 时间过长；
2. 而是 suppression 语义错误覆盖了风险升级；
3. 缩短时间只是降低错误概率，不能恢复正确业务语义。

### 5.4 不采用新增第二套 danger-side 专用状态机或调度器

不采用。原因：

1. 现有状态机主链路已经足够；
2. 现有 `AUTO_SYMBOL_SWITCH_DISTANCE` 调度与 `EMPTY + auto search tick` 重试链路已经存在；
3. 当前问题只发生在入口决策层，不需要再造新执行框架。

---

## 6. 最终设计决策

## 6.1 引入显式 trigger kind，但不把非法组合暴露到类型边界

修复后必须引入：

```ts
type SwitchTriggerKind = 'PERIODIC' | 'DISTANCE_SAFE_SIDE' | 'DISTANCE_DANGER_SIDE';
type SuppressibleSwitchTriggerKind = Extract<SwitchTriggerKind, 'PERIODIC' | 'DISTANCE_SAFE_SIDE'>;
```

但最终设计**不建议**简单地在现有 `StartSwitchFlowParams` 上裸加一个 `triggerKind` 字段并继续保留自由组合的 `switchMode`，因为那会让以下非法状态在类型层可表示：

- `switchMode: 'DISTANCE'` + `triggerKind: 'PERIODIC'`
- `switchMode: 'PERIODIC'` + `triggerKind: 'DISTANCE_DANGER_SIDE'`

因此最终方案要求：

- `startSwitchFlow(...)` 的入参改成**判别联合类型**；
- `switchMode` 仍可保留在运行时状态 `SwitchState` 中，用于现有状态机阶段分流；
- 但“触发入口入参”必须通过类型直接约束 `triggerKind` 与 `switchMode` 的合法关系。

推荐建模如下：

```ts
type StartPeriodicSwitchFlowParams = {
  readonly direction: 'LONG' | 'SHORT';
  readonly reason: string;
  readonly triggerKind: 'PERIODIC';
  readonly processImmediately: false;
};

type StartDistanceSwitchFlowParams = {
  readonly reason: string;
  readonly triggerKind: 'DISTANCE_SAFE_SIDE' | 'DISTANCE_DANGER_SIDE';
  readonly distanceContext: SwitchOnDistanceParams;
  readonly processImmediately: true;
};

type StartSwitchFlowParams = StartPeriodicSwitchFlowParams | StartDistanceSwitchFlowParams;
```

其中 distance 分支**不再重复声明顶层 `direction`**，统一以 `distanceContext.direction` 作为唯一来源，避免出现：

- 顶层 `direction = 'LONG'`
- `distanceContext.direction = 'SHORT'`

这类非法状态在类型边界可表示。

然后在 `startSwitchFlow(...)` 内部基于 `triggerKind` 派生：

- `PERIODIC` -> `switchMode = 'PERIODIC'`
- `DISTANCE_SAFE_SIDE | DISTANCE_DANGER_SIDE` -> `switchMode = 'DISTANCE'`

这样既能保留现有状态机主链路，又能阻止非法状态在类型边界出现。

## 6.2 suppression 只记录 suppressible trigger kind

`SwitchSuppression` 改为：

```ts
export type SwitchSuppression = {
  readonly symbol: string;
  readonly dateKey: string;
  readonly suppressedTriggerKinds: ReadonlySet<SuppressibleSwitchTriggerKind>;
};
```

继续保持：

- `switchSuppressions` 仍按方向存储一条记录；
- 这条记录绑定“当前被抑制的 symbol + 当前 HK 交易日”；
- 但记录内部必须能表达多个 suppressible trigger kind 并存。

### 设计要求

1. 只允许 `PERIODIC` 与 `DISTANCE_SAFE_SIDE` 写入 `suppressedTriggerKinds`；
2. `DISTANCE_DANGER_SIDE` 不允许出现在 suppression 数据模型中；
3. 对同方向、同 symbol、同日重复写入时，必须是**并集更新**，不能覆盖已有 kind；
4. 发生 symbol 变化或跨日时，仍按当前语义自动失效。

## 6.3 SeatStateManager 的 suppression 读写语义必须收紧

当前 `resolveSuppression(direction, seatSymbol)` / `markSuppression(direction, seatSymbol)` 改为：

- `resolveSuppression(direction, seatSymbol, triggerKind)`
- `markSuppression(direction, seatSymbol, triggerKind)`

其中 `triggerKind` 只允许是 `SuppressibleSwitchTriggerKind`。

### `resolveSuppression(...)` 的最终语义

只有以下条件同时满足时才命中：

1. 同方向；
2. 同 symbol；
3. 同 HK 交易日；
4. `triggerKind` 已存在于 `suppressedTriggerKinds`。

### 关键删除规则

这里必须特别约束：

- **仅当 `dateKey` 不同或 `symbol` 不同**时，才删除旧 suppression 记录；
- 若只是“同 symbol、同日，但 `triggerKind` 不在集合中”，必须返回 `null`，**但不得删除已有记录**。

这是本次方案的关键细节。否则会出现：

1. 先写入 `PERIODIC`
2. 再查询 `DISTANCE_SAFE_SIDE`
3. 因为 kind 不匹配而误删整条 suppression 记录
4. 导致后续 `PERIODIC` suppression 失效

这属于必须避免的逻辑错误。

### `markSuppression(...)` 的最终语义

1. 若当前方向无记录：新建记录，集合内只放当前 `triggerKind`；
2. 若同 symbol、同日已有记录：以新 Set 合并写回，不原地修改旧 Set；
3. 若 symbol 变化或跨日：重建为新记录；
4. 保持现有“跨日自动失效”语义。

## 6.4 用单一函数显式解析 distance 的 safe-side / danger-side 语义

在 `switchStateMachine.ts` 中新增统一解析函数，例如：

```ts
function resolveDistanceTriggerKind(params): 'DISTANCE_SAFE_SIDE' | 'DISTANCE_DANGER_SIDE' | null;
```

统一输入：

- `direction`
- `distancePercent`
- `switchDistanceRange`

统一输出：

- `DISTANCE_SAFE_SIDE`
- `DISTANCE_DANGER_SIDE`
- `null`

### 映射规则

#### LONG / BULL

- `distancePercent <= range.min` -> `DISTANCE_DANGER_SIDE`
- `distancePercent >= range.max` -> `DISTANCE_SAFE_SIDE`
- 区间内 -> `null`

#### SHORT / BEAR

- `distancePercent >= range.max` -> `DISTANCE_DANGER_SIDE`
- `distancePercent <= range.min` -> `DISTANCE_SAFE_SIDE`
- 区间内 -> `null`

### 最终要求

`maybeSwitchOnDistance(...)` 不再只做“区间外布尔判断”，而是：

1. 获取 `distancePercent`；
2. 调用 `resolveDistanceTriggerKind(...)`；
3. 若返回 `null`，直接结束；
4. 若返回 safe/danger，则带着明确 `triggerKind` 进入 `startSwitchFlow(...)`。

## 6.5 `startSwitchFlow(...)` 的 suppression 判定顺序重构

修复后的 `startSwitchFlow(...)` 仍保持当前主流程骨架，但 suppression 入口语义必须改为：

### 1）danger-side 不参与 suppression 判定

若 `triggerKind === 'DISTANCE_DANGER_SIDE'`：

- **不调用** `resolveSuppression(...)`
- 必须继续进入预寻标

这不是“命中 suppression 但放行”，而是：

- danger-side 从语义设计上就根本不受 suppression 规则约束。

### 2）只有 suppressible trigger 才能读取 suppression

仅当：

- `triggerKind === 'PERIODIC'`
- 或 `triggerKind === 'DISTANCE_SAFE_SIDE'`

时，才允许调用：

- `resolveSuppression(direction, seatSymbol, triggerKind)`

命中则直接 return。

### 3）其余顺序尽量保持当前主链路

即仍保持：

1. pending switch 检查；
2. active seat 检查；
3. suppression 检查（仅 suppressible trigger）；
4. 预寻标；
5. 席位版本与 symbol 再校验；
6. 周期触发前本地占用再校验；
7. same-symbol 处理；
8. clearSeat；
9. 写入 switchState；
10. 按当前逻辑决定是否立即推进状态机。

这样可以保证：

- 修改只发生在语义层；
- 现有状态机骨架与风险边界保持稳定。

## 6.6 same-symbol 命中时按 trigger kind 决定是否写 suppression

修复后：

### `PERIODIC`

- same-symbol 命中 -> `markSuppression(..., 'PERIODIC')`
- 结束本次触发

### `DISTANCE_SAFE_SIDE`

- same-symbol 命中 -> `markSuppression(..., 'DISTANCE_SAFE_SIDE')`
- 结束本次触发

### `DISTANCE_DANGER_SIDE`

- same-symbol 命中 -> **不写 suppression**
- 结束本次尝试
- 允许后续 danger-side 再次触发时重新进入预寻标

### 关键说明

danger-side same-symbol 不写 suppression，并不意味着本次要强行 clearSeat 或强行进入失败态。

本次仍然可以：

- 因候选仍是当前 symbol 而直接结束；

但不能把这次结果沉淀成“今天别再试了”的 suppression 状态。

## 6.7 保持 periodic pending / blockedBy 语义不变

当前代码中，周期换标存在：

- `pending`
- `pendingSinceMs`
- `blockedBy`

本次修复必须满足以下交互规则：

1. 若周期换标已处于 pending，distance trigger 只是 same-symbol 返回：
   - 不得清理 periodic pending；
   - 原有 pending 状态继续保留。
2. 若 distance trigger 真正启动换标：
   - 仍按当前逻辑接管并清理 periodic pending。
3. 若 danger-side same-symbol 命中：
   - 不写 suppression；
   - 也不误清 periodic pending；
   - 后续 periodic 等待语义继续有效。
4. 若后续 danger-side 找到新 symbol 并真正启动 distance switch：
   - distance switch 继续优先接管，行为保持现有语义。

这部分必须通过测试明确锁死。

## 6.8 保持现有失败后 `EMPTY + auto search tick` 链路不变

本次修复不修改以下逻辑：

1. 距离换标开始后如果 `nextSymbol === null`，仍按现有失败链路处理；
2. 失败后席位仍落回 `EMPTY`；
3. 失败次数累计、冻结逻辑维持现有规则；
4. 后续继续由 auto search tick 补齐空席位。

因此本次修复只需要确保：

- danger-side 不能在入口被 suppression 吃掉；
- 只要它真正重新进入决策链路，后续仍复用现有失败语义。

---

## 7. 影响文件清单

### 7.1 必改文件

1. `src/services/autoSymbolManager/types.ts`
   - 新增 `SwitchTriggerKind`
   - 新增 `SuppressibleSwitchTriggerKind`
   - 重构 `SwitchSuppression`
   - 重构 `SeatStateManager` suppression API 类型
   - 将 `StartSwitchFlowParams` 改为判别联合类型
   - 重构 `SwitchStateMachineDeps` suppression 相关签名

2. `src/services/autoSymbolManager/seatStateManager.ts`
   - 重写 suppression 查询与写入逻辑
   - 支持同日同 symbol 下多 suppressible trigger 并存
   - 修正 `triggerKind` 不匹配时“返回 null 但不删除记录”的行为

3. `src/services/autoSymbolManager/index.ts`
   - 透传新的 suppression 读写签名

4. `src/services/autoSymbolManager/switchStateMachine.ts`
   - 新增 distance trigger kind 解析函数
   - 重构 `startSwitchFlow(...)` suppression 判定规则
   - 重构 same-symbol 处理逻辑
   - 重构 periodic / distance 两条入口向 `startSwitchFlow(...)` 传参的方式

### 7.2 必改测试

5. `tests/services/autoSymbolManager/seatStateManager.business.test.ts`
6. `tests/services/autoSymbolManager/switchStateMachine.business.test.ts`
7. `tests/services/autoSymbolManager/periodicSwitch.business.test.ts`

### 7.3 必回归的集成测试

8. `tests/integration/periodic-auto-symbol-chain.integration.test.ts`
9. `tests/integration/auto-symbol-switch.integration.test.ts`
10. `tests/integration/auto-search-policy-consistency.integration.test.ts`

其中：

- `periodic-auto-symbol-chain.integration.test.ts` 必须锁定 periodic / distance / pending / 异步任务调度链路的联动回归；
- `auto-symbol-switch.integration.test.ts` 必须锁定 same-symbol、danger-side 重试与 EMPTY 回落等核心业务路径；
- `auto-search-policy-consistency.integration.test.ts` 必须锁定本次修复**不改变候选筛选口径**。

---

## 8. 全链路逻辑验证

本节用于验证方案本身是否自洽，而不是描述测试代码写法。

### 8.1 场景一：周期换标 same-symbol 命中

#### 前提

- `PERIODIC` 到期
- 当前 seat active
- 无本地阻塞
- 预寻标结果仍是当前 symbol

#### 修复后行为

1. `triggerKind = 'PERIODIC'`
2. 允许读取 `resolveSuppression(..., 'PERIODIC')`
3. 若未命中，则进入预寻标
4. same-symbol 命中后写入 `PERIODIC` suppression
5. 不 clearSeat，不进入 switchState
6. 本次结束

#### 结论

- 周期换标既有 same-symbol 去重语义保持不变。

### 8.2 场景二：distance safe-side same-symbol 命中

#### 前提

- 距离越界属于 safe-side
- 当前 seat active
- 预寻标结果仍是当前 symbol

#### 修复后行为

1. `triggerKind = 'DISTANCE_SAFE_SIDE'`
2. 允许读取 `resolveSuppression(..., 'DISTANCE_SAFE_SIDE')`
3. 若未命中，则进入预寻标
4. same-symbol 命中后写入 `DISTANCE_SAFE_SIDE` suppression
5. 不 clearSeat，本次结束

#### 结论

- safe-side 的重复噪音仍被当日 suppression 收敛。

### 8.3 场景三：已存在 safe-side suppression，随后升级到 danger-side

#### 前提

- 同方向、同 symbol、同日已有 `DISTANCE_SAFE_SIDE` suppression
- 后续价格继续演化，distance 进入 danger-side

#### 修复后行为

1. `triggerKind = 'DISTANCE_DANGER_SIDE'`
2. danger-side **不读取 suppression**
3. 重新进入预寻标
4. 若找到新 symbol，则启动换标
5. 若 same-symbol，则本次结束但不写 suppression
6. 若无候选，则继续走现有失败 -> `EMPTY` -> auto search tick 链路

#### 结论

- 风险升级不会被旧的 safe-side suppression 吞掉。

### 8.4 场景四：已存在 periodic suppression，随后升级到 danger-side

#### 前提

- 同方向、同 symbol、同日已有 `PERIODIC` suppression
- 后续 distance 进入 danger-side

#### 修复后行为

1. `triggerKind = 'DISTANCE_DANGER_SIDE'`
2. 不读取 periodic suppression
3. 重新进入预寻标
4. 后续分支与场景三一致

#### 结论

- `PERIODIC` 与 danger-side 语义完全解耦，periodic suppression 不会误伤 risk escalation。

### 8.5 场景五：同日同时存在 `PERIODIC` 与 `DISTANCE_SAFE_SIDE`

#### 前提

- 同方向、同 symbol、同日
- 先发生一次 periodic same-symbol
- 后发生一次 safe-side same-symbol

#### 修复后行为

1. 第一次写入 `PERIODIC`
2. 第二次查询 `DISTANCE_SAFE_SIDE` 时，因为只是 kind 不匹配，应返回 null 且不删除旧记录
3. 第二次 same-symbol 写入 `DISTANCE_SAFE_SIDE`
4. 最终集合中同时存在两个 kind
5. 后续 periodic 再触发时命中 periodic suppression
6. 后续 safe-side 再触发时命中 safe-side suppression

#### 结论

- 两类 suppressible trigger 能同日并存，且互不覆盖。

### 8.6 场景六：periodic pending 存在时，distance danger-side same-symbol

#### 前提

- 周期换标已进入 pending，等待本地空仓
- 同时发生 distance danger-side 触发
- 预寻标结果仍是当前 symbol

#### 修复后行为

1. distance 仍允许重新进入预寻标
2. same-symbol 后直接返回
3. 不写 suppression
4. 不 clearPeriodicPending
5. 原 pending 状态保持

#### 结论

- periodic pending 语义不被破坏；
- danger-side 后续仍可继续重试；
- 周期等待也仍然有效。

### 8.7 场景七：distance danger-side 重新进入后仍无候选

#### 前提

- danger-side 重新进入预寻标
- `findSwitchCandidate(...)` 返回 `null`

#### 修复后行为

1. 不受 suppression 拦截
2. 继续按当前 distance switch 主链路处理
3. 落入现有失败逻辑
4. 席位进入 `EMPTY`
5. 后续由 auto search tick 重试

#### 结论

- 用户要求的“危险侧重试失败后继续走现有空席位重试链路”成立。

### 8.8 场景八：LONG / SHORT 映射是否会写反

#### LONG

- 越接近 `range.min` 越接近回收价危险边界
- 所以 `<= min` 是 danger-side
- `>= max` 是 safe-side

#### SHORT

- 配置区间为负值区间，如 `[-1.5, -0.2]`
- 越接近零越危险
- 所以 `>= max` 是 danger-side
- `<= min` 是 safe-side

#### 结论

- 本方案的方向映射与当前业务口径一致，没有写反。

---

## 9. 详细测试方案

## 9.1 SeatStateManager 级测试

### 必测场景

1. **同 symbol / 同日 / 同 triggerKind 命中 suppression**
   - 记录 `PERIODIC`
   - 再以 `PERIODIC` 查询，命中

2. **同 symbol / 同日 / 不同 triggerKind 不命中，但不删除旧记录**
   - 先记录 `PERIODIC`
   - 再用 `DISTANCE_SAFE_SIDE` 查询
   - 返回 `null`
   - 随后再用 `PERIODIC` 查询仍然命中

3. **同 symbol / 同日 / 不同 suppressible triggerKind 可并存（正序）**
   - 先记录 `PERIODIC`
   - 再记录 `DISTANCE_SAFE_SIDE`
   - 两类查询都命中

4. **同 symbol / 同日 / 不同 suppressible triggerKind 可并存（逆序）**
   - 先记录 `DISTANCE_SAFE_SIDE`
   - 再记录 `PERIODIC`
   - 两类查询都命中
   - 不发生覆盖或误删

5. **LONG / SHORT 两个方向的 suppression 彼此隔离**
   - LONG 写入 suppression
   - SHORT 同 symbol 同日查询不命中

6. **同 symbol / 跨日自动失效**
   - 保持现有跨日失效语义

7. **symbol 变化时旧 suppression 自动失效**
   - 当前 symbol 与记录 symbol 不同
   - 旧记录删除并返回 `null`

8. **danger-side 不允许进入 suppression API**
   - 类型层面直接禁止
   - 不为其编写运行时兜底分支

## 9.2 SwitchStateMachine 级测试

### LONG / BULL

1. `distance >= max` 且 same-symbol 命中
   - 识别为 `DISTANCE_SAFE_SIDE`
   - 写入 safe-side suppression

2. `distance <= min` 且 same-symbol 命中
   - 识别为 `DISTANCE_DANGER_SIDE`
   - 不写 suppression

3. 先写入 safe-side suppression，再发生 danger-side 触发
   - danger-side 不能被 suppression 拦截
   - 必须重新进入预寻标

4. 先写入 periodic suppression，再发生 danger-side 触发
   - danger-side 不能被 periodic suppression 吞掉

### SHORT / BEAR

5. `distance <= min` 且 same-symbol 命中
   - 识别为 `DISTANCE_SAFE_SIDE`
   - 写入 safe-side suppression

6. `distance >= max` 且 same-symbol 命中
   - 识别为 `DISTANCE_DANGER_SIDE`
   - 不写 suppression

7. 先写入 safe-side suppression，再发生 danger-side 触发
   - danger-side 必须重新进入预寻标

### failure / retry

8. danger-side 重新进入预寻标但找不到候选
   - 继续走失败 -> `EMPTY` -> 后续重试链路

### periodic pending 交互

9. periodic pending 存在时，distance safe-side same-symbol
   - periodic pending 保留
   - safe-side suppression 写入成功

10. periodic pending 存在时，distance danger-side same-symbol

- periodic pending 保留
- 不写 suppression

11. periodic pending 存在时，distance 找到新 symbol 并接管

- periodic pending 被清理
- distance switch 正常启动

## 9.3 PeriodicSwitch 级测试

必须重点复核并更新现有热点用例：

1. `case4-1`
   - 现有语义依赖“distance same candidate 被 suppression 拦截”
   - 修复后必须拆分 safe-side 与 danger-side 两条行为
   - 其中 danger-side 分支不再以 suppression 为前提

2. `case5`
   - 继续验证 periodic same-symbol 会写 `PERIODIC` suppression

3. 新增：`PERIODIC` 与 `DISTANCE_SAFE_SIDE` 同日并存
   - 二者都能独立命中

4. 新增：periodic suppression 存在时，danger-side 仍然可以重入预寻标

## 9.4 集成测试

### 必补回归场景

1. **safe-side 抑制后升级到 danger-side**
   - 第一次 same-symbol 发生在 safe-side
   - 记录 safe-side suppression
   - 后续升级到 danger-side
   - 必须重新进入预寻标

2. **danger-side 重试失败走 EMPTY + auto search tick**
   - danger-side 进入预寻标
   - 无候选
   - 落入 `EMPTY`
   - 后续由 auto search tick 承接

3. **periodic suppression 不影响 danger-side**
   - 先发生 periodic same-symbol
   - 后续 danger-side 到来
   - 仍必须重进预寻标

4. **danger-side 重试节奏仍受现有距离任务调度边界约束**
   - `AUTO_SYMBOL_SWITCH_DISTANCE` 任务只在 `monitorPriceChanged` 或存在 pending switch 时调度
   - same-symbol 直接返回时不会制造新的 pending switch
   - 因此修复后 danger-side 的重复重试不会平白新增额外定时器或心跳级轮询，而是继续受现有价格变动驱动

5. **候选筛选口径不变**
   - `auto-search-policy-consistency.integration.test.ts` 继续验证：
     - 启动补席
     - 运行中空席补席
     - 距离换标前预寻标三条链路依然共用同一套候选筛选规则

6. **关键类型边界不可构造非法组合**
   - distance 分支不存在顶层 `direction` 与 `distanceContext.direction` 双源冲突
   - 非 suppressible trigger 不能传入 suppression API

---

## 10. 实施顺序建议

### 步骤 1：先改类型与接口边界

优先修改：

- `SwitchTriggerKind`
- `SuppressibleSwitchTriggerKind`
- `SwitchSuppression`
- `StartSwitchFlowParams`
- `SeatStateManager` / `SwitchStateMachineDeps` 中的 suppression API 签名

目标是先从类型层禁止继续沿用旧 suppression 语义。

### 步骤 2：实现 SeatStateManager 的新 suppression 语义

完成：

- 同日同 symbol 多 kind 并存
- kind 不匹配时不误删旧记录
- 跨日 / symbol 变化时正确失效

### 步骤 3：实现 switchStateMachine 的 trigger kind 解析与入口改造

完成：

- distance safe/danger 解析
- danger-side 绕过 suppression
- same-symbol 分 trigger 处理
- periodic 与 distance 两条入口按新类型传参

### 步骤 4：修复业务测试

至少修复：

- `seatStateManager.business.test.ts`
- `switchStateMachine.business.test.ts`
- `periodicSwitch.business.test.ts`

### 步骤 5：补充集成回归测试

至少补：

- safe-side -> danger-side 升级打破 suppression
- danger-side 无候选 -> `EMPTY + auto search tick`
- periodic suppression 不影响 danger-side
- danger-side 重试仍受现有距离任务调度边界约束
- 候选筛选口径不变

### 步骤 6：全量回归

至少执行：

1. `tests/services/autoSymbolManager/*`
2. `tests/integration/periodic-auto-symbol-chain.integration.test.ts`
3. `tests/integration/auto-symbol-switch.integration.test.ts`
4. `tests/integration/auto-search-policy-consistency.integration.test.ts`
5. `bun lint`
6. `bun type-check`

---

## 11. 风险与边界说明

### 11.1 最大风险：LONG / SHORT 危险侧方向写反

这是本次最容易出错的点，必须用 LONG 与 SHORT 双向测试锁死：

- LONG：`min` 危险，`max` 安全
- SHORT：`max` 危险，`min` 安全

### 11.2 最大实现细节风险：kind 不匹配时误删旧 suppression

这是二次分析后新增确认的关键风险点。

若实现成：

- 只要四条件不全满足就 delete 记录

则会破坏“同日多 trigger 并存”的目标。

因此必须明确：

- 只有跨日或 symbol 变化时才删除记录；
- kind 不匹配时只返回 `null`，不删除。

### 11.3 不应改变周期换标原有 same-symbol suppression 行为

本次修复不是削弱 periodic suppression，而是让 danger-side 不再被它误伤。

### 11.4 不应改变候选筛选口径

本次修复只改“触发语义与 suppression 语义”，不改：

- 主阈值口径
- 安全区间口径
- 严格层 / 降级层筛选规则
- 启动补席 / 空席补席 / 距离换标前预寻标三条链路的一致性

### 11.5 不应改变失败计数与冻结策略

danger-side 重新进入预寻标后若仍失败：

- 继续沿用现有失败次数累计与冻结逻辑；
- 本次修复不顺手调整这些规则。

### 11.6 不应改变 periodic pending / blockedBy 语义

修复后必须继续保证：

- pending 状态只在正确时机清理；
- blockedBy 仍仅表达本地占用来源；
- distance switch 真正接管时才清 pending；
- same-symbol 结束不应误清 pending。

### 11.7 不应引入新的 danger-side 额外轮询或节流体系

当前距离换标任务调度边界是：

- `AUTO_SYMBOL_SWITCH_DISTANCE` 仅在 `monitorPriceChanged` 或存在 pending switch 时调度；
- same-symbol 直接返回不会创建新的 pending switch。

因此本次修复后：

- danger-side 的重复重试继续受现有距离任务调度边界约束；
- 不新增第二套 danger-side 专用定时器；
- 也不额外引入新的节流状态机。

如果后续发现真实运行负载不可接受，应作为独立问题重新建模，而不是在本次修复里混入新的补丁式节流逻辑。

---

## 12. 最终方案结论

本问题的正确修复方向已经明确：

> **将“当日抑制”从按 symbol 一刀切的统一布尔语义，重构为按 suppressible trigger kind 分类的 suppression 语义，并让 danger-side 从设计上绕过 suppression。**

修复后的最终业务行为应为：

1. `PERIODIC` 可抑制；
2. `DISTANCE_SAFE_SIDE` 可抑制；
3. `DISTANCE_DANGER_SIDE` 不可抑制；
4. `PERIODIC` 与 `DISTANCE_SAFE_SIDE` 的 suppression 可同日并存且互不覆盖；
5. danger-side same-symbol 命中不再写 suppression；
6. 在不存在进行中的 switch 且距离任务被调度执行的前提下，danger-side 后续升级可继续重新进入预寻标/换标；
7. danger-side 若最终无候选，仍走现有 `EMPTY + auto search tick` 链路；
8. periodic pending / blockedBy 与候选筛选口径维持现有正确语义，不因本次修复被破坏；
9. 不引入新的 danger-side 额外轮询或补丁式节流体系，继续受现有距离任务调度边界约束。

这是在**不改现有换标主状态机骨架**的前提下，恢复正确业务语义的最短路径系统性修复方案。

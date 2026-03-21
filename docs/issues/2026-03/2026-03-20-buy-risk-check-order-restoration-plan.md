# 买入风险检查顺序恢复重构方案

## 1. 文档目标

本文档用于落地“买入检查必须先做轻型检查，再做重型检查”的顺序恢复重构。

本次方案严格遵守以下边界：

1. **只恢复顺序，并修正“失败买入不应刷新买入频率状态”的业务约束。**
2. **买入仍必须使用实时账户与持仓信息。**
3. **实时账户/持仓拉取失败时，买入仍直接拒绝。**
4. **任一前置检查失败时，不得消耗买入频率限制。**
5. **不为多监控标的并发、同批多信号共用检查额外设计。**
6. **不处理自动换标回补买入绕过买入间隔的问题。**

本次目标非常单一：

- 把当前错误的“先拉账户/持仓，再做买入间隔等轻检查”
- 恢复为“先做买入间隔等轻检查，通过后才拉账户/持仓并执行基础风险检查”
- 同时修正当前方案中潜在的错误语义：**风险检查阶段任一失败都不应刷新买入频率状态**

---

## 2. 问题背景

当前 `riskCheckPipeline` 的实现把账户/持仓 API 预取放在了买入轻检查之前。

现状链路位于：

- `src/core/signalProcessor/riskCheckPipeline.ts`

当前顺序是：

1. 风险检查冷却过滤
2. **账户/持仓 API 预取**
3. 交易频率限制
4. 清仓冷却
5. `recordBuyAttempt`
6. 买入价格限制
7. 末日保护
8. 牛熊证风险
9. 基础风险检查

这违反了既定设计原则：

- 买入间隔必须是第一道买入门禁；
- 轻检查应尽可能先拦截无效买入；
- 只有在买入确实有资格继续时，才允许触发重型检查。

这也是 429 问题的直接放大器：

- 即使某个买入本应被买入间隔拦截，
- 当前实现也会先调用 `getAccountSnapshot()` 和 `getStockPositions()`，
- 从而无谓消耗交易 API 配额。

---

## 3. 当前实现复核

### 3.1 当前错误顺序的代码位置

当前实现位于：

- `src/core/signalProcessor/riskCheckPipeline.ts:115-130`
- `src/core/signalProcessor/riskCheckPipeline.ts:184-277`

现有代码先执行：

```ts
const hasBuySignals = signalsAfterCooldown.some((signal) => isBuyAction(signal.action));
...
if (hasBuySignals) {
  const [nextAccount, nextPositions] = await Promise.all([
    trader.getAccountSnapshot(),
    trader.getStockPositions(),
  ]);
}
```

之后才进入买入轻检查：

```ts
const tradeCheck = trader.canTradeNow(sig.action, context.config);
```

这就是顺序错误的核心。

### 3.2 当前真实生产调用形态

当前生产调用点位于：

- `src/main/asyncProgram/buyProcessor/index.ts:162`

真实调用为：

```ts
signalProcessor.applyRiskChecks([signal], riskCheckContext);
```

也就是当前生产路径按**单任务、单信号**执行买入风险检查。

因此本次方案不再围绕“同批多个买入信号共享一次账户/持仓检查”设计，而是直接围绕**单个买入信号的顺序恢复**设计。

---

## 4. 根因结论

### 4.1 根因一：账户/持仓拉取被错误前移到轻检查之前

`086f3af fix trade api频率问题` 把账户/持仓获取提升到了 `applyRiskChecks` 前段。

结果是：

- 交易频率限制不再是第一道门禁；
- 重型检查在很多本应被轻检查拦截的场景下被提前触发。

### 4.2 根因二：接口层“signals[]”抽象掩盖了当前真实执行模型

虽然 `applyRiskChecks` 接口接受 `signals: Signal[]`，但当前生产路径实际上按 `[signal]` 单元素调用。

因此，现有“先批量预取一次账户/持仓”的设计收益在当前生产路径中并不成立，反而破坏了顺序正确性。

---

## 5. 修复目标

本次重构后，系统必须满足以下不变量：

1. **买入轻检查顺序恢复正确：**
   - 交易频率限制（只读检查，不写状态）
   - 清仓冷却
   - 买入价格限制
   - 末日保护
   - 牛熊证风险
   - 实时账户/持仓拉取
   - 基础风险检查
2. **任一轻检查失败时，不允许触发账户/持仓 API。**
3. **买入仍必须使用实时账户/持仓，不回退缓存。**
4. **实时账户/持仓拉取失败时，买入仍直接拒绝。**
5. **风险检查阶段任一失败时，不允许刷新买入频率状态。**
6. **买入频率状态只允许在实际成功提交买单后更新，沿用现有下单提交链路中的更新语义。**
7. **卖出路径不受影响，继续使用现有缓存/基础风险检查逻辑。**

---

## 6. 不采用的方案

### 6.1 不保留“先批量预取，再轻检查”的顺序

不采用。原因：

1. 这正是当前 bug 本身。
2. 它直接违背“轻检查优先”的业务原则。
3. 会在买入间隔、清仓冷却、价格限制等场景下无谓消耗交易 API。

### 6.2 不引入缓存降级

不采用。原因：

1. 你已明确选择方案 1，仅恢复顺序。
2. 买入实时风控口径必须保持不变。
3. 使用缓存会改变风险边界，属于业务语义变化，不属于本次修复范围。

### 6.3 不为同批/多标的并发增加两阶段批处理设计

不采用。原因：

1. 当前生产路径真实调用形态是 `applyRiskChecks([signal], ...)`。
2. 这次修复目标是最短路径恢复正确顺序与频率状态语义。
3. 继续为“同批多个买入信号”做额外结构设计，会扩大改动面并增加回归风险。

### 6.4 不在风险检查阶段保留 `recordBuyAttempt` 预占位

不采用。原因：

1. 你已明确确认：**任一检查失败导致的买入中断都不应该消耗买入频率限制。**
2. 若在风险检查阶段调用 `recordBuyAttempt`，则价格限制、末日保护、牛熊证风险、实时账户/持仓拉取失败、基础风险检查失败等路径都会提前刷新频率状态，导致业务语义偏移。
3. 当前真实的买入频率更新时间已经存在于实际下单提交成功链路，不需要额外在风险检查阶段再做预占位。

### 6.5 不改 `buyProcessor`、`trader`、`orderExecutor`

不采用。原因：

1. 当前错误发生在 `riskCheckPipeline` 内部顺序与文档方案本身对频率状态时机的定义。
2. 买入间隔的真实成功更新时间已在下单提交链路中存在，本次无需额外改动 `trader` / `orderExecutor` 来新增机制。
3. 扩大到其他模块会明显增加 blast radius。

---

## 7. 最短路径重构方案

### 7.1 改动范围

本次只修改以下文件：

- `src/core/signalProcessor/riskCheckPipeline.ts`
- `tests/core/signalProcessor/riskCheckPipeline.business.test.ts`
- `tests/regression/risk-pipeline-regression.test.ts`

不修改以下文件：

- `src/main/asyncProgram/buyProcessor/index.ts`
- `src/core/trader/*`
- `src/services/autoSymbolManager/*`

### 7.2 重构后的买入检查顺序

重构后，买入信号在 `riskCheckPipeline` 中的顺序固定为：

1. 风险检查冷却过滤
2. 交易频率限制（只读检查，不写状态）
3. 清仓冷却
4. 买入价格限制
5. 末日保护
6. 牛熊证风险
7. 实时账户/持仓拉取
8. 基础风险检查

说明：

- `riskCheckPipeline` 不再承担买入频率状态预占位职责。
- 买入频率状态继续沿用实际下单提交成功后的更新时间语义。
- 因此，风险检查阶段任一失败都不会刷新买入频率限制。

### 7.3 具体实现方式

#### 步骤 1：删除循环前的账户/持仓预取块

删除 `riskCheckPipeline.ts` 中以下整段逻辑：

- `const hasBuySignals = ...`
- `let freshAccount = ...`
- `let freshPositions = ...`
- `let buyApiFetchFailed = ...`
- `if (hasBuySignals) { ... }`

也即删除当前位于：

- `src/core/signalProcessor/riskCheckPipeline.ts:115-130`

这一步的目的只有一个：

- **彻底移除“轻检查前重型预取”的错误入口。**

#### 步骤 2：删除买入分支顶部对 `buyApiFetchFailed` 的依赖

删除当前买入分支开头的：

```ts
if (buyApiFetchFailed) {
  const reason = '批量获取账户和持仓信息失败，买入信号被拒绝';
  sig.reason = reason;
  logger.warn(...);
  continue;
}
```

因为在新顺序下：

- 账户/持仓 API 还没有拉取；
- 此时不应该存在 `buyApiFetchFailed` 这种前置状态。

#### 步骤 3：保留现有买入轻检查，但删除风险检查阶段的 `recordBuyAttempt`

以下逻辑**保留业务判断顺序，但不再在风险检查阶段写入买入频率状态**：

1. `trader.canTradeNow(sig.action, context.config)`
2. `getMonitorCooldownRemainingMs(...)`
3. `orderRecorder.getLatestBuyOrderPrice(...)`
4. `doomsdayProtection.shouldRejectBuy(...)`
5. `riskChecker.checkWarrantRisk(...)`

注意：

- 本次必须删除风险检查阶段中的 `trader.recordBuyAttempt(sig.action, context.config)`。
- 原因不是代码整洁，而是业务约束已经明确：**任一检查失败导致的买入中断都不应消耗买入频率限制。**
- 继续在风险检查阶段调用 `recordBuyAttempt`，会让价格限制、末日保护、牛熊证风险、实时账户/持仓拉取失败、基础风险检查失败等路径错误刷新频率状态。

#### 步骤 4：把实时账户/持仓拉取移动到牛熊证风险检查之后、基础风险检查之前

在买入轻检查全部通过后，新增单信号实时拉取逻辑：

```ts
let accountForRiskCheck: AccountSnapshot | null = null;
let positionsForRiskCheck: ReadonlyArray<Position> = [];

try {
  const [nextAccount, nextPositions]: [AccountSnapshot | null, ReadonlyArray<Position>] =
    await Promise.all([trader.getAccountSnapshot(), trader.getStockPositions()]);
  accountForRiskCheck = nextAccount;
  positionsForRiskCheck = nextPositions;
} catch (err) {
  const reason = '获取实时账户和持仓信息失败，买入信号被拒绝';
  sig.reason = reason;
  logger.warn('[风险检查] 获取实时账户和持仓信息失败，买入信号将被拒绝', formatError(err));
  logger.warn(`[风险检查] ${reason}：${signalLabel}`);
  continue;
}
```

这里要注意 3 点：

1. **拒绝原因与日志语义要与真实行为一致。**
   - 这里已不是“主循环前批量预取”，而是“单信号轻检查通过后的实时拉取”。
2. **只在买入轻检查全部通过后触发。**
   - 这是本次修复的核心。
3. **拉取失败直接拒绝买入，但不得刷新买入频率状态。**
   - 这条约束必须由测试钉死。

#### 步骤 5：卖出继续使用现有上下文缓存，不接入实时账户/持仓拉取

卖出路径不改，继续保持：

```ts
const accountForRiskCheck = context.account;
const positionsForRiskCheck = context.positions;
```

也就是：

- 卖出不因为本次改造增加额外 API 调用
- 卖出不受买入账户/持仓拉取失败的影响

#### 步骤 6：更新 `checkBeforeOrder(...)` 的入参来源

重构后基础风险检查的数据来源变成：

- 买入：使用刚刚实时拉取到的 `accountForRiskCheck / positionsForRiskCheck`
- 卖出：继续使用 `context.account / context.positions`

建议写成显式分支，避免再出现“统一变量在前段提前初始化”的回归风险。

#### 步骤 7：买入频率状态继续沿用成功提交买单后的更新语义

当前真实的买入频率状态更新时间已经存在于下单提交链路：

- `src/core/trader/orderExecutor/submitFlow.ts:205`

即：

- 订单成功提交并得到 `orderId` 后才执行 `updateLastBuyTime(signal.action, monitorConfig)`。
- 本次修复不在 `riskCheckPipeline` 内新增替代机制，也不在风险检查阶段做预占位。
- 这样可以确保“失败买入不刷新频率、成功提交买单才刷新频率”的业务语义闭环。

---

## 8. 建议的代码结构

本次不新增文件，也不拆模块；只在 `riskCheckPipeline.ts` 内做局部重排。

建议结构如下：

1. 冷却过滤
2. `for (const sig of signalsAfterCooldown)` 主循环
3. 进入买入分支后：
   - 轻检查链（只读，不写频率状态）
   - 实时账户/持仓拉取
   - 基础风险检查
4. 非买入分支：
   - 直接使用上下文缓存执行基础风险检查

这次不引入新的 helper 文件；若需要抽局部函数，也只允许在本文件内抽出一个私有函数，例如：

- `fetchRealtimeBuyRiskContext(...)`

但不是必须条件。若抽函数，必须满足：

1. 只负责“实时获取账户和持仓”；
2. 不承载业务判断；
3. 不引入新的抽象层和状态对象；
4. 不改变现有依赖注入结构。

---

## 9. 注释与文档同步要求

### 9.1 更新 `riskCheckPipeline.ts` 内顺序注释

当前注释写的是：

- `0. 账户/持仓 API 批量预取`
- 风险检查阶段包含 `recordBuyAttempt` 预占位语义

这部分必须删除并改成正确顺序说明。

新的顺序注释必须明确写成：

1. 交易频率限制（只读检查，不写状态）
2. 清仓冷却
3. 买入价格限制
4. 末日保护
5. 牛熊证风险
6. 实时账户/持仓拉取
7. 基础风险检查

同时要注明：

- 实时账户/持仓拉取是买入重型检查前置步骤；
- 仅在轻检查全部通过后执行；
- 拉取失败直接拒绝买入；
- 风险检查阶段任一失败都不得刷新买入频率状态。

### 9.2 更新 `src/core/signalProcessor/types.ts` 中接口顺序描述（必做）

`SignalProcessor.applyRiskChecks` 的注释必须同步更新为和实现一致，至少明确：

- 买入轻检查顺序
- 买入在基础风险检查前才拉取实时账户/持仓
- 风险检查阶段不更新买入频率状态
- 卖出继续使用缓存上下文执行基础风险检查

---

## 10. 测试重构方案

## 10.1 修改 `tests/core/signalProcessor/riskCheckPipeline.business.test.ts`

### 场景一：验证顺序已恢复为“轻检查先，重检查后”

保留并增强现有顺序测试（可重命名以反映新语义）：

- `executes buy checks in business order before realtime buy risk fetch`

需要把断言增强到明确包含：

- `canTradeNow`
- `getRemainingMs`
- `checkWarrantRisk`
- `getAccountSnapshot`
- `getStockPositions`
- `checkBeforeOrder`

正确顺序必须满足：

1. `canTradeNow` 在 `getAccountSnapshot/getStockPositions` 之前
2. `getRemainingMs` 在 `getAccountSnapshot/getStockPositions` 之前
3. `checkWarrantRisk` 在 `getAccountSnapshot/getStockPositions` 之前
4. `checkBeforeOrder` 在 `getAccountSnapshot/getStockPositions` 之后
5. 风险检查阶段不再出现 `recordBuyAttempt`

### 场景二：交易频率限制拦截时，不调用账户/持仓 API，也不刷新买入频率状态

新增测试：

- 构造 `canTradeNow: () => ({ canTrade: false, waitSeconds: 59 })`
- `getAccountSnapshot/getStockPositions` 内部若被调用则抛错或计数
- `recordBuyAttempt` 若被调用则抛错或计数
- 断言：
  - 返回结果为空
  - `signal.reason` 包含 `交易频率限制`
  - `getAccountSnapshot/getStockPositions` 调用次数为 `0`
  - `recordBuyAttempt` 调用次数为 `0`

### 场景三：清仓冷却拦截时，不调用账户/持仓 API，也不刷新买入频率状态

新增测试：

- `canTradeNow` 通过
- `getRemainingMs` 返回正数
- 断言：
  - 返回结果为空
  - `signal.reason` 包含 `清仓冷却期内`
  - `recordBuyAttempt` 调用次数为 `0`
  - `getAccountSnapshot/getStockPositions` 调用次数为 `0`

### 场景四：买入价格限制拦截时，不调用账户/持仓 API，也不刷新买入频率状态

新增测试：

- `canTradeNow` 通过
- 清仓冷却通过
- `getLatestBuyOrderPrice` 返回低于/等于当前价的触发条件
- `recordBuyAttempt` 若被调用则抛错或计数
- 断言：
  - 返回结果为空
  - `signal.reason` 包含 `买入价格限制`
  - `getAccountSnapshot/getStockPositions` 调用次数为 `0`
  - `recordBuyAttempt` 调用次数为 `0`

### 场景五：末日保护拦截时，不调用账户/持仓 API，也不刷新买入频率状态

新增测试：

- `doomsdayProtection.shouldRejectBuy` 返回 `true`
- 断言：
  - API 调用次数为 `0`
  - `recordBuyAttempt` 调用次数为 `0`

### 场景六：牛熊证风险拦截时，不调用账户/持仓 API，也不刷新买入频率状态

新增测试：

- `checkWarrantRisk` 返回 `allowed: false`
- 断言：
  - API 调用次数为 `0`
  - `recordBuyAttempt` 调用次数为 `0`

### 场景七：轻检查全部通过后，实时账户/持仓拉取失败则拒绝买入，且不刷新买入频率状态

保留并调整现有失败测试，确保语义变成：

- 失败发生在轻检查之后
- 返回结果为空
- `signal.reason` 包含 `获取实时账户和持仓信息失败`
- `recordBuyAttempt` 调用次数为 `0`
- 若下一次买入未成功提交，则不应因本次失败被 `canTradeNow` 拦截

### 场景八：买入基础风险检查失败时，不刷新买入频率状态

新增测试：

- 轻检查通过
- 实时账户/持仓拉取成功
- `checkBeforeOrder` 返回 `allowed: false`
- 断言：
  - 返回结果为空
  - `signal.reason` 包含基础风险拒绝原因
  - `recordBuyAttempt` 调用次数为 `0`
  - 后续未成功提交的下一次买入不应被频率限制拦截

### 场景九：同次调用内买入实时拉取失败，不影响卖出路径继续使用缓存风控

保留并调整现有 mixed buy/sell 测试，确保语义变成：

- 买入因实时账户/持仓拉取失败被拒绝
- 卖出仍继续使用 `context.account / context.positions` 完成基础风险检查
- 最终结果仍保留卖出信号

## 10.2 修改 `tests/regression/risk-pipeline-regression.test.ts`

### 回归一：风险检查阶段失败不刷新买入频率状态

新增回归测试，覆盖至少以下失败路径：

- 买入价格限制失败
- 实时账户/持仓拉取失败
- 基础风险检查失败

统一验证：

- 风险检查失败后，下一次未成功提交前的买入不应仅因前一次失败而被 `canTradeNow` 拦截。

### 回归二：风险检查冷却或买入间隔提前拦截时，买入 API 不应被调用

新增或增强回归测试，确保未来不会再次把账户/持仓获取前移到轻检查之前。

### 回归三：同次调用 mixed buy/sell 时，买入实时拉取失败不污染卖出路径

新增或增强回归测试，确保未来不会把买入实时拉取失败扩散为整次 `applyRiskChecks(signals[])` 调用失败。

---

## 11. 实施步骤

### 任务 1：恢复 `riskCheckPipeline` 顺序与买入频率状态语义

**Files:**

- Modify: `src/core/signalProcessor/riskCheckPipeline.ts`
- Modify: `src/core/signalProcessor/types.ts`

- [ ] 删除循环前的 `hasBuySignals + freshAccount/freshPositions + buyApiFetchFailed` 预取块。
- [ ] 删除买入分支顶部对 `buyApiFetchFailed` 的依赖判断。
- [ ] 删除风险检查阶段中的 `trader.recordBuyAttempt(...)` 调用。
- [ ] 保留现有轻检查顺序，但明确“交易频率限制只读检查，不写状态”。
- [ ] 在牛熊证风险通过后、基础风险检查前新增单信号实时账户/持仓拉取。
- [ ] 拉取失败时使用与真实行为一致的拒绝原因和日志语义。
- [ ] 卖出路径继续使用 `context.account / context.positions`。
- [ ] 更新 `riskCheckPipeline.ts` 与 `signalProcessor/types.ts` 注释，删除“批量预取”和风险检查阶段 `recordBuyAttempt` 预占位表述。

### 任务 2：补强业务测试

**Files:**

- Modify: `tests/core/signalProcessor/riskCheckPipeline.business.test.ts`

- [ ] 增强“买入检查顺序”测试，把 `getAccountSnapshot/getStockPositions` 纳入步骤断言，并断言风险检查阶段不再调用 `recordBuyAttempt`。
- [ ] 新增“交易频率限制拦截不触发账户/持仓 API，也不刷新买入频率状态”测试。
- [ ] 新增“清仓冷却拦截不触发账户/持仓 API，也不刷新买入频率状态”测试。
- [ ] 新增“买入价格限制拦截不触发账户/持仓 API，也不刷新买入频率状态”测试。
- [ ] 新增“末日保护拦截不触发账户/持仓 API，也不刷新买入频率状态”测试。
- [ ] 新增“牛熊证风险拦截不触发账户/持仓 API，也不刷新买入频率状态”测试。
- [ ] 调整“账户/持仓获取失败拒绝买入”测试到新顺序语义，并断言失败不刷新买入频率状态。
- [ ] 新增“基础风险检查失败不刷新买入频率状态”测试。
- [ ] 调整 mixed buy/sell 测试，确保买入实时拉取失败不污染卖出路径。

### 任务 3：补强回归测试

**Files:**

- Modify: `tests/regression/risk-pipeline-regression.test.ts`

- [ ] 删除或改写依赖 `recordBuyAttempt` 预占位的旧回归测试。
- [ ] 新增“风险检查阶段失败不刷新买入频率状态”的回归测试。
- [ ] 新增或增强“轻检查提前拦截时 API 调用次数为 0”的回归测试。
- [ ] 新增或增强 mixed buy/sell 场景下“买入实时拉取失败不污染卖出路径”的回归测试。

### 任务 4：命令验证

**Files:**

- Modify: `src/core/signalProcessor/riskCheckPipeline.ts`
- Modify: `tests/core/signalProcessor/riskCheckPipeline.business.test.ts`
- Modify: `tests/regression/risk-pipeline-regression.test.ts`

- [ ] 运行：`bun test tests/core/signalProcessor/riskCheckPipeline.business.test.ts`
- [ ] 运行：`bun test tests/regression/risk-pipeline-regression.test.ts`
- [ ] 如有需要，运行：`bun test tests/integration/buy-flow.integration.test.ts`
- [ ] 运行：`bun lint`
- [ ] 运行：`bun type-check`
- [ ] 确认所有断言、lint、类型检查通过后再进入实际修复提交阶段。

---

## 12. 风险点与检查重点

本次重构最容易出问题的点只有 5 个：

1. **风险检查阶段仍残留 `recordBuyAttempt` 或其他频率状态预占位。**
   - 会导致失败买入错误刷新买入频率限制，直接违反业务约束。
2. **误把卖出路径也改成实时拉账户/持仓。**
   - 会扩大 API 压力并偏离当前业务语义。
3. **拒绝原因和日志文案仍停留在“批量预取”语义。**
   - 会导致日志语义失真和测试断言漂移。
4. **轻检查失败时仍残留 API 调用。**
   - 这会让本次修复失去意义。
5. **买入实时拉取失败错误污染同次调用中的卖出路径。**
   - 会让数组接口现有语义发生非预期回归。

因此评审重点必须集中在：

- 轻检查失败路径上是否完全没有 `getAccountSnapshot/getStockPositions`
- 风险检查阶段是否完全不再刷新买入频率状态
- 买入拉取失败是否仍然直接拒绝，且不影响卖出路径
- 卖出路径是否完全未受影响

---

## 13. 最终方案摘要

本次修复不做批处理设计，不处理多标的并发，不改变买入实时风控口径，也不修改其他模块。

本次修复做两件且仅两件事：

1. **把 `riskCheckPipeline` 中买入账户/持仓拉取从轻检查之前移回轻检查之后。**
2. **移除风险检查阶段对买入频率状态的预占位，恢复“失败买入不刷新频率、成功提交买单才刷新频率”的业务语义。**

具体来说：

- 删除循环前统一预取；
- 保留现有轻检查顺序，但风险检查阶段不再写入买入频率状态；
- 在牛熊证风险通过后再实时拉取账户和持仓；
- 拉取失败仍直接拒绝买入；
- 买入频率状态继续沿用下单提交成功后的更新时间语义；
- 卖出路径不动；
- 用业务测试和回归测试把“轻检查优先、重检查后置、失败不刷新频率”钉死。

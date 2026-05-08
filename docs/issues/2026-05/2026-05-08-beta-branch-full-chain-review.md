# Beta 分支全链路审查报告

审查日期: 2026-05-08 审查范围: beta 分支 (4708ca2 + 4c4f1e2) vs main 分支变更规模: 101 文件, +6773/-717 行

## 审查方法

采用第一性原理方法，从原始业务逻辑和需求出发，在以下维度进行平行审查：

1. **错误分类与 fail-fast/fatal 传播分析** — 验证 `apiFailure` 模块设计与传播全链路
2. **核心业务逻辑正确性** — 基于 core-program-business-logic 知识库逐条验证
3. **TypeScript 规范合规性** — 按 typescript-project-specifications 规范审查
4. **过度设计与兜底/回退逻辑检测** — 按 CLAUDE.md 规范检测

---

## 0. 变更概要

本次重构的核心目标：**区分"外部 API 请求失败"和"程序内部逻辑错误"**。

- 新增 `src/utils/apiFailure/` 模块：统一的外部 API 失败分类、有限重试包装、程序错误识别
- 所有 Longbridge SDK API 调用迁移到 `wrapExternalApiRequest` 包装
- 新增 `onFatalError` / `drainFatalError` 机制：将非 API 的程序错误传播到顶层
- 移除了多处静默吞错逻辑（返回 `null`/`[]`/`continue`），改为 fail-fast
- `StartupSnapshotResult` 从 boolean 标志改为 discriminated union (`'READY' | 'API_RETRY_PENDING'`)
- 新增 `SEAT_REFRESH` 延迟重试机制
- 末日保护撤单增加 `nextRetryAtMs` 重试调度

---

## 1. 确认问题 (需要修复)

### 1.1 【高危】末日清仓 submitOrder 失败后错误传播导致程序崩溃

**文件**: `src/main/timeWakeupEvaluationProgram/index.ts` (line 476-494), `src/main/timeWakeupRuntime/index.ts` (line 136)

**问题描述**:

当末日清仓 (`doomsdayProtection.executeClearance`) 抛出 `ExternalApiRequestError` 且 `operation === 'TradeContext.submitOrder'` 时：

```typescript
// timeWakeupEvaluationProgram (line 476-494)
if (error.operation === 'TradeContext.submitOrder') {
  try {
    await refreshDoomsdayApiFailureFacts({...});  // 刷新事实
  } catch (refreshError) {
    // 处理刷新错误
  }
  throw error;  // ← 重新抛出 ExternalApiRequestError
}
```

这个 `throw error` 传播到 `timeWakeupRuntime.runEvaluationLoop` (line 136):

```typescript
} catch (error) {
  failFatal(error);  // ← 所有错误都变为 FATAL，不区分 API/程序
}
```

**业务影响**: 末日清仓期间如果下单 API 失败（response 丢失），即使事实刷新成功后状态已一致，程序仍会崩溃退出，而非进入调度重试。这与项目中 "API 请求失败允许显式重试" 的原则冲突。

**根因**: `timeWakeupEvaluationProgram` 中 `submitOrder` 分支的 `throw error` 没有与 `runEvaluationLoop` 的 `failFatal(error)` 语义对齐。事实刷新成功后应 push API_RETRY 候选并 return evaluation result。

**修复建议**:

```typescript
if (error.operation === 'TradeContext.submitOrder') {
  try {
    await refreshDoomsdayApiFailureFacts({...});
  } catch (refreshError) {
    if (!isExternalApiRequestError(refreshError)) {
      throw refreshError;
    }
    logger.warn('[TimeWakeupEvaluation] 末日清仓提交结果未知后的事实刷新失败', refreshError.message);
  }
  // 改为调度重试而非 throw：
  logger.warn('[TimeWakeupEvaluation] 末日清仓下单 API 请求失败，等待系统级重评估');
  pushApiRetryCandidate(candidates, currentMs);
  return createEvaluationResult(currentTime, candidates);
}
```

---

### 1.2 【中危】switchWakeupRuntime 将所有错误（含 API 错误）路由到 fatal

**文件**: `src/main/monitorQuoteEventRuntime/switchWakeupRuntime.ts` (line 493-498, 583-586)

**问题描述**:

```typescript
const processingPromise = processRouteQueue(routeKey).catch((error: unknown) => {
  logger.error('[SwitchWakeupRuntime] pending switch 推进失败', formatError(error));
  deps.onFatalError?.(error); // ← 不区分 API/程序错误，全进 fatal
});
```

`processRouteQueue` 内部执行多个 API 操作（waitForFresh → getPendingOrders → cancelOrder → submitOrder），任一步骤的 transient API 错误都会触发程序 fatal 关闭。

**业务影响**: 距离换标是风控核心路径（标的距回收价超出安全区间）。但 transient API 错误不应导致整个程序崩溃。如果换标暂时无法推进，席位应保持当前状态，等待下次重评估。

**修复建议**: `switchWakeupRuntime` 的 `.catch()` 处理应区分 `ExternalApiRequestError`（记录警告但不 fatal）和程序错误（走 fatal 通道）。

```typescript
.catch((error: unknown) => {
  logger.error('[SwitchWakeupRuntime] pending switch 推进失败', formatError(error));
  if (!isExternalApiRequestError(error)) {
    deps.onFatalError?.(error);
  }
  // API 错误：等待下次事件唤醒重试
});
```

---

## 2. 需要讨论的设计决策

### 2.1 自动寻标异常不再累加 fail count

**文件**: `src/services/autoSymbolManager/autoSearch.ts` (line 96-128), `src/main/recovery/seatPreparation.ts` (line 292-310)

**现状**: API 异常路径保留席位的原有 `searchFailCountToday` 和 `frozenTradingDayKey`，不累加。只有 "无候选标的"（null result）才计数。

**问题**: 如果 Longbridge API 持续故障，每次系统级时间唤醒都会重新触发寻标尝试，不累加 fail count → 不会触发当日冻结 → 可能消耗大量 API 调用。

**讨论**: 这可能是**有意设计**——Transient API 错误不应计入失败配额，因为失败配额本意是限制"逻辑上找不到合适标的"的次数而非"网络故障"次数。但需要确认是否需要增加一个独立的 API 故障退避机制。

**建议**: 当前设计合理但需要补充一个跨周期的 API 故障退避（如连续 N 次 API 故障后暂停 30 分钟），避免 API 额度被 transient 故障消耗。

### 2.2 drainFatalError 模式重复 4 次

**文件**: `createAsyncRuntime.ts`, `createPostGateRuntime.ts`, `createPostTradeConsistencyRuntime.ts`, `autoSearchWakeupRuntime/index.ts`

**现状**: 相同的 `fatalError`/`fatalRejectors`/`handleFatalError`/`drainFatalError` 模式在 4 处独立实现。

**讨论**: 根据项目"保持最短路径实现"原则，这是可接受的。但若未来需要修改 fatal 传播语义（如增加 error context），需要同步修改 4 处。

**建议**: 暂不抽取，保持当前实现。如果未来需要增加 fatal error metadata 或统一日志格式，再考虑抽取共享工具。

### 2.3 SEAT_REFRESH 延迟重试的设计

**文件**: `src/main/asyncProgram/monitorTaskProcessor/index.ts` (line 121-298)

**现状**: 席位刷新 API 失败后，通过 `setTimeout` + 重新入队实现一次延迟重试，而非在 `wrapExternalApiRequest` 中直接配置 retries。

**设计原因**: 延迟重试需要重新验证席位版本/状态是否仍然有效（可能在重试期间席位已变更），因此不能简单地在 `wrapExternalApiRequest` 中阻塞重试。

**结论**: ✅ 设计合理，不是过度设计。

### 2.4 getPendingOrders 从静默降级改为 fail-fast

**文件**: `src/core/trader/orderCacheManager.ts`

**现状**: 数据无效时 throw 而非返回 `[]`。

**调用点分析**:

- `doomsdayProtection.cancelPendingBuyOrders`: ✅ 外部有 try-catch，处理正确
- `switchStateMachine.advancePendingSwitch`: ⚠️ 无 try-catch，错误传播到 switchWakeupRuntime → 见问题 1.2
- 其他调用: ✅ 均通过 Trader 接口，错误传播路径已覆盖

**结论**: fail-fast 正确，但 switchWakeupRuntime 需要修复（见 1.2）。

---

## 3. 验证通过的设计

### 3.1 apiFailure 模块设计

- `wrapExternalApiRequest` 正确区分传输层错误（包装为 `ExternalApiRequestError`）和 SDK 错误码（通过 `shouldRetry` 控制）
- Schema 验证断言在 `wrapExternalApiRequest` 外部执行 → API 返回无效数据时 TypeError → fail-fast → **正确**（API 契约违反不是 transient 故障）
- `WeakSet` + 属性检查的识别机制可靠
- `isProgramError` 覆盖 `TypeError`/`ContractError`/`InvariantError` 合理

### 3.2 启动快照 discriminated union

- `StartupSnapshotResult` 从 `startupRebuildPending: boolean` 改为 `'READY' | 'API_RETRY_PENDING'`
- 不提供空事实（quotesMap 传 null 而非空 Map → 避免下游依赖虚假数据）
- 生命周期恢复链路持续推进重建，交易放行关闭但不阻断系统级时间唤醒

### 3.3 末日保护撤单的 nextRetryAtMs

- `cancelCheckExecutedDate` 只在全部成功时设置 → 部分失败下次重新扫描（但已完成撤单的不会重复出现）
- `FAILED`/`RETRYABLE_FAILURE` 设置 `nextRetryAtMs` → 时间唤醒调度合理间隔重试
- 15 分钟窗口限制总重试次数 → 有界循环，不会无限

### 3.4 风险检查管线的 fail-fast

- 账户/持仓获取失败 → throw → 信号不进入后续买入流程
- `lastRiskCheckTime.delete(cooldownKey)` 在 catch 中正确重置冷却
- `retryConfig: {retries: 0}` → 不在买入管线内重试，由上游重试 → 符合"失败不静默"原则

### 3.5 doomsdayProtection refreshDoomsdayApiFailureFacts

- 末日清仓提交状态未知时，刷新订单、持仓、订阅
- 刷新后的下一次系统级重评估会基于最新事实重新判断
- **注意**: 当前因问题 1.1 的 throw 导致无法到达重评估 → 修复 1.1 后此设计将正确工作

---

## 4. TypeScript 规范合规性 (摘要)

- ✅ Type checking 通过 (`tsc -p tsconfig.json` 零错误)
- ✅ 无 `any` 使用、无 `@ts-ignore`、无 re-export
- ✅ `types.ts` 文件只有类型定义，`index.ts` 文件只有实现
- ✅ 所有新增类型使用 `readonly`，数据结构使用 `type`，行为契约使用 `interface`
- ✅ 类型注释完整（文件头、类型块注释、函数 JSDoc）
- ⚠️ 轻微问题: `DEFAULT_EXTERNAL_API_RETRY_CONFIG` 常量在 `apiFailure/index.ts` 中定义，按代码组织规范应放在 `constants/` 下
- ⚠️ 轻微问题: `apiFailure/index.ts` 缺少文件头 `/** ... */` 注释

---

## 5. 总结

### 必须修复

| # | 问题 | 文件 | 严重程度 |
| --- | --- | --- | --- |
| 1.1 | 末日清仓 submitOrder 失败后 throw 导致程序 fatal | `timeWakeupEvaluationProgram/index.ts:493` | 🔴 高 |
| 1.2 | switchWakeupRuntime 不区分 API/程序错误全进 fatal | `switchWakeupRuntime.ts:493,583` | 🟡 中 |

### 建议修复

| # | 问题 | 文件 | 严重程度 |
| --- | --- | --- | --- |
| 2.1 | 缺少跨周期 API 故障退避（自动寻标） | `autoSearch.ts`, `seatPreparation.ts` | 🟢 低 |
| 2.2 | drainFatalError 模式 4 处重复 | 多个文件 | 🟢 低 |
| TS | `DEFAULT_EXTERNAL_API_RETRY_CONFIG` 应移至 `constants/` | `apiFailure/index.ts` | 🟢 低 |
| TS | `apiFailure/index.ts` 缺少文件头注释 | `apiFailure/index.ts` | 🟢 低 |

### 整体评估

本次重构在 fail-fast 原则和 API 失败重试边界的工程设计上是**正确的**。核心抽象 (`wrapExternalApiRequest` / `isExternalApiRequestError` / `isProgramError`) 设计清晰，错误分类边界合理。业务逻辑修改方向正确——移除静默吞错，使错误可追溯、可观测。

两个确认问题 (1.1, 1.2) 的根因一致：**错误传播链的收口层（timeWakeupRuntime.runEvaluationLoop 和 switchWakeupRuntime.catch）没有区分 ExternalApiRequestError 和程序错误**，导致本应重试的 API 错误被升级为 fatal。修复方案简单且影响范围可控。

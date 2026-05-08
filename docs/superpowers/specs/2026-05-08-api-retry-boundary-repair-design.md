# API 失败重试边界真实问题修复设计

日期：2026-05-08

## 背景与目标

本次修复目标是只处理当前代码中仍真实存在、且违反仓库 fail-fast 与 API retry 边界的问题。

核心原则：

- 外部 API 请求失败表示权威事实暂时不可确认，只能通过显式 retry owner 处理。
- 内部契约错误、状态不变量错误、非 API 程序错误必须 fail-fast。
- 不能把未知事实伪造成空事实、业务拒绝、无候选或普通任务失败。
- `TradeContext.submitOrder` 是非幂等提交边界，请求结果未知时不能盲目系统级重提。

## 范围内问题

1. `ExternalApiRequestError` 仍可通过结构伪造进入 API retry 分类。
2. 启动/重建席位寻标 catch-all 会把 API 失败和程序错误都计入寻标失败/冻结。
3. 启动/恢复阶段写入的 `ACTIVATING` 席位可能没有 `SEAT_REFRESH` owner。
4. `SEAT_REFRESH` API 失败只重试一次后可能永久停在 `ACTIVATING`。
5. 买入前实时账户/持仓与卖出数量解析仍使用默认 API retry。
6. `riskCheckPipeline` 对普通非 API 错误仍可能转成“拒绝买入”。
7. 末日清仓 `TradeContext.submitOrder` unknown outcome 仍可能进入普通 `API_RETRY` 后重复提交。
8. `orderCacheManager.todayOrders` 会静默丢弃单条坏结构订单。
9. post-trade 浮亏刷新返回 `null` 被当作可重试失败。
10. `delayedSignalVerifier.onVerified` 回调错误被吞掉，且 pending 已删除。
11. `tradingRiskEventRuntime` 与 `switchWakeupRuntime` 的 route 异常只记录日志，无法被上层观测。

## 范围外问题

- `accountService` 空账户已抛 `TypeError`，不重复修。
- `submitFlow` 对 `TradeContext.submitOrder` 已使用 `retries: 0` 并重抛，不重构。
- 普通 buy/sell processor 已把 `submitOrder` API failure 送入 fatal，不重构。
- `orderApiManager.todayOrders` 已有数组与单条结构断言，不修改。
- `SEAT_REFRESH` 回收价无效回 `EMPTY` 是正确业务失败，不修改该语义。

## 设计

### 1. API 错误品牌化

在 `src/utils/apiFailure/index.ts` 增加模块私有 brand。只有 `createExternalApiRequestError` 与 `createExternalApiAggregateRequestError` 创建的错误带 brand。`isExternalApiRequestError` 必须同时满足：

- 是 `Error`。
- 带私有 brand。
- `operation` 是非空字符串。
- `attempts` 是正整数。

这保证普通内部错误即使伪造合法字段，也不能进入 API retry 分类。

### 2. 席位恢复寻标错误分类

`prepareSeatsForRuntime` 中同步寻标仍可把席位短暂置为 `SEARCHING`，但错误处理必须分层：

- 未找到候选：按现有业务规则计数、可能冻结、回 `EMPTY`。
- `ExternalApiRequestError`：回 `EMPTY`，不增加失败次数、不冻结，然后向外抛出，由启动/重建 owner 进入显式恢复路径。
- 非 API 错误：回 `EMPTY` 后向外抛出，保持 fail-fast。

### 3. 恢复阶段 ACTIVATING 必须有刷新 owner

恢复链路中写入 `ACTIVATING` 的席位必须进入与运行态相同的 seat activation barrier。最短路径是在恢复后显式调度对应 `SEAT_REFRESH`，或把恢复阶段的激活写入收敛到现有事件化调度入口。

选择原则：不扫描全局状态做补丁式修复；调度必须发生在产生 `ACTIVATING` 的 owner 旁边，保证状态与任务同源。

### 4. SEAT_REFRESH API 失败终态

`SEAT_REFRESH` API 失败可以有限 retry，但 retry 耗尽后不能停留在 `ACTIVATING`。终态为：

- 当前席位版本、标的、状态仍匹配任务快照时，回 `EMPTY` 并 bump version。
- 旧 retry timer 与旧任务自然失效。
- 后续由自动寻标 owner 重新推进。
- 非 API 错误继续进入 fatal，不走回 `EMPTY` 的业务失败路径。

### 5. 高时效读取 no-retry

给账户与持仓读取提供明确 no-retry 调用路径，用于：

- 买入前实时账户/持仓检查。
- 卖出数量解析中的可用持仓读取。

这些边界失败表示“本次信号无法可靠确认事实”，不应在业务链路内等待默认 retry 后继续推进。

### 6. riskCheckPipeline fail-fast

买入前实时账户/持仓读取 catch 分支只保留：

- `ExternalApiRequestError`：释放已占用的风险冷却并向外抛出，由异步 processor 当前 API failure 语义处理。
- 程序错误或其他普通错误：直接抛出。

不再把普通 Error 转成业务拒绝。

### 7. 末日清仓 submitOrder unknown outcome

`TradeContext.submitOrder` 失败时即使刷新事实失败或未发现新订单，也不能安排普通 `API_RETRY` 重提清仓。处理方式：

- 保留一次事实刷新尝试，用于尽快收敛本地缓存。
- 对 `operation === 'TradeContext.submitOrder'` 的 `ExternalApiRequestError` 抛出可观测 fatal / unknown submit outcome。
- 后续人工或上层恢复必须先确认权威订单与持仓事实，不能由系统级时间唤醒盲目再次提交。

### 8. 订单缓存信任边界

`orderCacheManager.getPendingOrders` 对 `todayOrders()` 返回值逐条断言。任一订单结构不满足最低解析契约时抛 `TypeError`，不再 `filter` 静默丢弃。

### 9. Post-trade 浮亏刷新 null fail-fast

在 `createPostTradeConsistencyRuntime` 中，`refreshUnrealizedLossData()` 返回 `null` 表示内部协作者或状态契约错误，应抛 `TypeError`。只有 `ExternalApiRequestError` 能进入成交后一致性 retry。

### 10. Delayed verifier 回调错误可观测

`delayedSignalVerifier` 不吞 `onVerified` 回调错误。验证通过后的分流失败必须向 runtime / 调用方暴露，不只记录日志。若现有定时器调用栈需要异步错误通道，则引入最小 `onFatalError` 端口；不做信号重试或补偿。

### 11. Route runtime 异常可观测

`tradingRiskEventRuntime` 与 `switchWakeupRuntime` 的 route processing catch 不再只写日志。内部错误必须进入可观测 fatal 通道或由 `stopAndDrain` 暴露；`STOP_AND_DRAIN` 主动中断仍视为正常生命周期中断。

## 测试策略

新增或调整测试覆盖：

- 合法字段 fake `ExternalApiRequestError` 不通过 `isExternalApiRequestError`。
- 启动恢复寻标 API 失败不冻结，非 API 错误 fail-fast。
- 恢复阶段产生 `ACTIVATING` 会调度 `SEAT_REFRESH`。
- `SEAT_REFRESH` retry 耗尽后回 `EMPTY`，不再停留 `ACTIVATING`。
- 买入前账户/持仓读取和卖出数量持仓读取 attempts 为 1。
- `riskCheckPipeline` 普通 Error fail-fast，且不进入基础风控。
- 末日清仓 `submitOrder` failure 不进入普通 `API_RETRY`。
- `orderCacheManager.todayOrders` 单条坏订单抛 `TypeError`。
- post-trade 浮亏刷新 `null` 进入 fatal，不重试。
- `delayedSignalVerifier.onVerified` 抛错可观测。
- route runtime 内部错误可观测，`STOP_AND_DRAIN` 仍不升级。

## 验证命令

实现后按顺序执行：

```bash
bun format
bun lint
bun type-check
```

并运行相关 targeted tests；若 targeted tests 通过，再按风险扩展到更大的业务测试集合。

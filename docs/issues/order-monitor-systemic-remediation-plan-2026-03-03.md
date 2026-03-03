# 订单监控二次验证与系统性修复方案（2026-03-03）

## 1. 文档目标

本方案用于在已提交修复基础上完成二次确认，给出一个**系统性且完整性**的重构方案，彻底解决以下问题：

1. 本地追踪状态与交易所终态不一致导致的无限循环问题。
2. 撤单/改单错误码处理语义不精确导致的新回归风险。
3. 订单关闭、副作用记账、追踪清理之间的跨模块一致性问题。

本方案明确要求：不采用兼容性补丁，不保留旧语义委托链，进行全链路语义升级。

## 2. 二次验证范围与方法

### 2.1 验证范围

1. `orderMonitor` 下单后追踪、超时撤单、超时转市价、WebSocket 终态处理链路。
2. `cancelOrder` 语义在调用方链路的传播：`quoteFlow`、`recoveryFlow`、`orderExecutor`、`doomsdayProtection`、`autoSymbolManager`。
3. `replaceOrder` 失败处理、防抖、状态更新链路。

### 2.2 已执行验证

1. 静态检查：`bun run type-check`、`bun run lint`。
2. 自动化测试：`bun test` 全量。
3. 定向复现实验：使用 `tradeContextMock` 注入真实错误码和网络失败场景。

### 2.3 二次验证结论（关键结果）

| 场景                                     | 实验结果                                     | 结论                         |
| ---------------------------------------- | -------------------------------------------- | ---------------------------- |
| 买单超时 + `601011`                      | `cancelCalls=1`，后续不重复撤单              | 原无限撤单问题在该场景被抑制 |
| 卖单超时 + `601012`                      | `cancelCalls=1`，`submitCalls=1`（仍转市价） | 存在高风险重复卖出回归       |
| 买单超时 + 网络失败 + 后续 `Filled` 推送 | `recordLocalBuyCount=0`                      | 存在成交副作用丢失回归       |

## 3. 现状问题矩阵（基于二次验证）

## 3.1 已解决

1. 识别 `601011` 后可清理本地追踪，阻断原始无限撤单循环。
2. `602012` 场景增加了改单抑制，降低改单风暴。

## 3.2 未完成与新增风险（必须修复）

1. `cancelled: boolean` 语义过粗，无法区分 `已撤销` 与 `已成交`。
2. `601012` 被当作“撤单成功”等价处理，卖单超时分支会继续转市价，产生重复卖出风险。
3. 买单超时撤单失败后无条件删除追踪，若后续收到成交推送，会因找不到 `trackedOrder` 丢失 `recordLocalBuy` 副作用。
4. `markSellCancelled` 复用于所有“关闭”错误路径，未区分 `FILLED` 与 `CANCELED`，副作用语义错误。
5. `602013`（状态不允许改单）被与 `602012`（类型不支持改单）同等永久处理，语义混淆。
6. 文档声明的错误码专项测试文件未落地，关键分支未被测试锁定。

## 4. 系统性修复目标

1. 统一订单关闭语义：将“关闭原因”作为一等模型，而不是布尔值。
2. 统一状态收口：所有追踪清理走单一关闭收口函数，杜绝散点删除。
3. 统一副作用规则：成交、撤销、拒绝、未知终态各自有明确副作用策略。
4. 统一失败策略：可重试失败与终态失败分离，避免“误删追踪”与“无限重试”双风险。
5. 统一验证体系：新增错误码链路测试矩阵和端到端回归门禁。

## 5. 总体重构设计

## 5.1 核心设计变更 A：撤单结果从 `boolean` 升级为判别联合类型

### 目标

彻底替换 `cancelled: boolean`，实现精确决策。

### 新模型（建议）

```ts
type CancelOrderOutcome =
  | { kind: 'CANCEL_CONFIRMED'; closedReason: 'CANCELED' | 'REJECTED'; source: 'API' | 'WS' }
  | {
      kind: 'ALREADY_CLOSED';
      closedReason: 'CANCELED' | 'FILLED' | 'REJECTED' | 'NOT_FOUND';
      source: 'API_ERROR';
    }
  | { kind: 'RETRYABLE_FAILURE'; errorCode: string | null; message: string }
  | { kind: 'UNKNOWN_FAILURE'; errorCode: string | null; message: string };
```

### 改造要求

1. `OrderMonitor.cancelOrder`、`Trader.cancelOrder`、所有调用方同步改为 `CancelOrderOutcome`。
2. 删除旧布尔语义，不保留兼容分支。

## 5.2 核心设计变更 B：订单关闭收口统一化

### 目标

建立唯一关闭收口函数，所有关闭路径统一进入：

1. API 撤单成功。
2. API 返回已关闭错误码。
3. WebSocket 推送终态。
4. 恢复对账判定终态。

### 收口函数职责

1. 更新 `trackedOrders` 生命周期状态。
2. 按关闭原因执行正确副作用。
3. 清理 `orderHoldRegistry`。
4. 写入可观测日志与指标。
5. 保证幂等（重复终态事件不重复记账）。

## 5.3 核心设计变更 C：关闭原因驱动的副作用矩阵

| closedReason | 本地订单记录                               | 卖单 pendingSell    | 追踪清理           |
| ------------ | ------------------------------------------ | ------------------- | ------------------ |
| `FILLED`     | 必须走成交路径（若缺成交明细先进入同步态） | `markSellFilled`    | 成交记账完成后清理 |
| `CANCELED`   | 不记成交                                   | `markSellCancelled` | 立即清理           |
| `REJECTED`   | 不记成交                                   | `markSellCancelled` | 立即清理           |
| `NOT_FOUND`  | 先对账判定，不直接假设撤销                 | 暂不执行取消副作用  | 对账完成后决定     |

## 5.4 核心设计变更 D：超时策略重构

### 买单超时

1. 撤单返回 `CANCEL_CONFIRMED` 或 `ALREADY_CLOSED(CANCELED/REJECTED)` 才清理。
2. 撤单返回 `ALREADY_CLOSED(FILLED)` 进入成交同步流程，不可当作撤销。
3. 撤单返回 `RETRYABLE_FAILURE` 不删除追踪，进入退避重试（记录 `nextCancelAttemptAt`）。

### 卖单超时

1. 仅在“确认非成交终态”后，且剩余数量仍大于 0，才允许转市价。
2. 若 `ALREADY_CLOSED(FILLED)`，必须停止转市价并走成交同步。
3. 若 `RETRYABLE_FAILURE`，不转市价，进入退避重试，避免重复下单。

## 5.5 核心设计变更 E：改单语义分离

1. `602012`：类型不支持改单，标记 `replaceCapability='UNSUPPORTED_BY_TYPE'`，永久禁改。
2. `602013`：状态不允许改单，标记 `replaceCapability='TEMP_BLOCKED_BY_STATUS'`，仅本轮/短时退避，不永久禁改。
3. 改单关闭类错误码进入“关闭收口函数”，不在 `replaceOrder` 内直接散点清理。
4. `NON_REPLACEABLE_ORDER_STATUSES` 增补取消中状态，防止无效改单风暴。

## 5.6 核心设计变更 F：事件缺失下的定向对账机制

### 目标

解决“API 已闭环但 WS 终态缺失”与“先删追踪后到达终态事件”的一致性问题。

### 机制

1. 引入 `closeSyncQueue`（按 `orderId` 去重）。
2. 触发条件：`ALREADY_CLOSED(FILLED/NOT_FOUND)`、`UNKNOWN_FAILURE`、关键事件缺失。
3. 执行策略：定向拉取订单快照/成交信息并完成闭环。
4. 重试策略：有限重试 + 指数退避 + 告警，不允许静默丢弃。

## 6. 模块级改造清单（全量）

1. `src/core/trader/types.ts`：替换 `CancelOrderResult`，新增关闭原因和结果判别模型。
2. `src/core/trader/orderMonitor/types.ts`：新增生命周期状态类型、对账队列类型。
3. `src/core/trader/orderMonitor/orderOps.ts`：重写 `cancelOrderWithRuntimeCleanup` 为 `cancelOrderWithOutcome`，移除布尔返回。
4. `src/core/trader/orderMonitor/quoteFlow.ts`：改为 outcome 驱动决策，删除“撤单失败强制删追踪”逻辑。
5. `src/core/trader/orderMonitor/eventFlow.ts`：未命中追踪但收到终态时进入对账，不直接忽略。
6. `src/core/trader/orderMonitor/utils.ts`：错误码解析升级，区分 `602012` 与 `602013`，错误码解析支持结构化字段优先。
7. `src/constants/index.ts`：拆分错误码集合，按业务语义分组，不再混用“已关闭”等价集。
8. `src/core/trader/orderExecutor/submitFlow.ts`：`CANCEL_AND_SUBMIT` 分支基于 outcome 判定是否允许继续提交。
9. `src/core/doomsdayProtection/index.ts`：撤单结果按 outcome 判定日志和计数。
10. `src/services/autoSymbolManager/switchStateMachine.ts`：撤单失败分支改为 outcome 语义，避免误判。
11. `src/core/trader/orderMonitor/recoveryFlow.ts`：恢复期撤单和对账统一 outcome 处理。

## 7. 实施阶段计划（系统性落地）

### 阶段 1：模型与接口升级

1. 定义新 outcome 类型与关闭原因模型。
2. 全链路替换 `boolean` 撤单返回。
3. 编译通过并清理全部旧语义代码。

### 阶段 2：关闭收口与超时流程重构

1. 落地单一关闭收口函数。
2. 重写买卖超时逻辑为 outcome 驱动。
3. 删除散点 `trackedOrders.delete`。

### 阶段 3：改单与错误码策略重构

1. 拆分 `602012/602013` 处理。
2. 完整接入关闭收口函数。
3. 增补取消中状态的禁改策略。

### 阶段 4：定向对账与一致性保障

1. 实现 `closeSyncQueue` 与调度。
2. 对账完成后统一触发关闭收口。
3. 增加告警与观测指标。

### 阶段 5：测试与回归门禁

1. 新增错误码专项测试。
2. 新增超时+网络失败+迟到事件测试。
3. 新增卖单 `601012` 防重复卖出测试。
4. 通过 `bun run lint`、`bun run type-check`、`bun test` 全量。

## 8. 测试矩阵（必须新增）

1. `cancelOrder` 返回 `ALREADY_CLOSED(FILLED)` 时，卖单超时不得转市价。
2. 买单超时撤单网络失败后，迟到 `Filled` 事件必须补齐 `recordLocalBuy`。
3. `601011` 只清理一次，不重复撤单。
4. `602012` 永久禁改，`602013` 临时退避后可恢复评估。
5. `NOT_FOUND` 进入对账流程并最终收口。
6. 关闭收口幂等：重复终态事件不重复记账。

## 9. 验收标准（量化）

1. 不再出现同一订单每秒撤单重试日志风暴。
2. `sell-timeout + 601012` 场景 `submitOrder` 次数必须为 0。
3. `buy-timeout + network-fail + filled-event` 场景 `recordLocalBuy` 次数必须为 1。
4. 全量测试通过，新增关键用例全部纳入 CI。
5. 无旧布尔撤单语义残留。

## 10. 风险与控制

1. 风险：接口语义升级影响调用面广。
   控制：分阶段提交，每阶段全量测试与类型门禁。
2. 风险：对账逻辑增加复杂度。
   控制：仅定向触发，队列去重与限流，禁止全量轮询。
3. 风险：终态幂等处理缺陷导致重复记账。
   控制：关闭收口函数内建立幂等键与重复终态保护。

## 11. 本次二次结论

现有修复已缓解原问题，但未形成完整闭环，且引入了高风险回归。  
必须按本方案进行**语义级重构**，将“布尔成功/失败”升级为“终态原因驱动”，并统一关闭收口与定向对账，才能达到系统性、完整性修复目标。

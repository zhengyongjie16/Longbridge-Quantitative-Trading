# 代码审查问题记录

**日期**：2026-03-10 **审查范围**：全链路复核，涵盖卖单执行链路、订单记录、风控、启动恢复、配置校验、类型规范 **状态说明**：已完成二次复核；删除 1 项无需修复问题（L），并收窄 2 项表述（D、G）

---

## 严重问题（必须修复）

---

### 问题 A：卖单合并分支破坏 relatedBuyOrderIds 占用一致性

**严重级别**：严重 **涉及文件**：

- `src/core/trader/orderExecutor/submitFlow.ts:245`（REPLACE 分支）
- `src/core/trader/orderExecutor/submitFlow.ts:264`（CANCEL_AND_SUBMIT 分支）
- `src/core/trader/orderMonitor/closeFlow.ts:183`（markSellFilled 收口）
- `src/core/orderRecorder/orderStorage.ts:555`（selectSellableOrders 占用过滤）

#### 问题描述

系统在提交卖单时通过 `orderRecorder.submitSellOrder` 登记 `relatedBuyOrderIds`（被该卖单占用的买入订单），防止后续卖出决策重复选中同一批买单。卖单合并逻辑（`resolveSellMergeDecision`）存在两条分支，两者均未正确维护这份占用记录。

**REPLACE 分支**

当决策为 `REPLACE` 时，`replaceOrderPrice` 只修改现有待成交卖单的价格和合并数量，不更新 `orderRecorder` 中该 pending sell 的 `relatedBuyOrderIds` 和 `submittedQuantity`。新信号触发合并的那批买单（`signal.relatedBuyOrderIds`）从未被加入占用集合，处于未保护状态。在合并单成交前，这些买单可以被后续卖出决策再次选中，导致重复卖出同一批买单。

合并单成交后，`markSellFilled` 取回的是旧的 `relatedBuyOrderIds`，`recordLocalSell` 只按旧买单扣减账本，新触发合并的买单仍保留在账本中，再次暴露给后续决策。

**CANCEL_AND_SUBMIT 分支**

当决策为 `CANCEL_AND_SUBMIT` 时，旧订单被撤销后 `markSellCancelled` 释放其 `relatedBuyOrderIds`，旧买单重新暴露。新提交的订单（`submitOrder`）只记录新信号的 `relatedBuyOrderIds`，不包含旧订单对应的买单。

合并后的新单成交时，`recordLocalSell` 只按新信号的买单扣减账本，旧批次买单（已被合并卖出的实质数量）仍留在账本中，后续可被再次选中。

#### 风险

- 同一批买入订单被多次计入卖出决策，引发超量卖出
- 账本中持仓数量与实际持仓持续偏高，影响浮亏计算和后续风控

#### 修复方向

- **REPLACE**：在调用 `replaceOrderPrice` 后，同步更新该 pending sell 记录的 `relatedBuyOrderIds`（合并旧有 + 新信号的买单 ID 集合），以及 `submittedQuantity`
- **CANCEL_AND_SUBMIT**：新订单提交时，`relatedBuyOrderIds` 应为「新信号买单 + 被取消订单原有买单」的并集

---

### 问题 B：卖单部分成交后撤单/拒单，已成交部分不落本地账本

**严重级别**：严重 **涉及文件**：

- `src/core/trader/orderMonitor/eventFlow.ts:84`（PartialFilled 处理）
- `src/core/trader/orderMonitor/closeFlow.ts:144`（finalizeOrderClose CANCELED/REJECTED 路径）

#### 问题描述

卖单经历「部分成交 → 撤单/拒单」的终态时，已成交部分不会写入任何账本记录。

**PartialFilled 事件**（`eventFlow.ts:84`）：

```typescript
if (event.status === OrderStatus.PartialFilled && trackedOrder.side === OrderSide.Sell) {
  orderRecorder.markSellPartialFilled(orderId, trackedOrder.executedQuantity);
  // 只更新占用量，不写账本
}
```

`markSellPartialFilled` 仅更新 pending sell 记录中的 `filledQuantity` / `status`，不触发任何账本写入。

**CANCELED/REJECTED 事件**（`closeFlow.ts:254`）：

```typescript
if ((closedReason === 'CANCELED' || closedReason === 'REJECTED') && sideText === 'SELL') {
  const cancelledSell = orderRecorder.markSellCancelled(orderId);
  relatedBuyOrderIds = cancelledSell?.relatedBuyOrderIds ?? null;
  // 无 recordLocalSell / dailyLossTracker.recordFilledOrder / recordTrade 调用
}
```

`finalizeOrderClose` 的 CANCELED/REJECTED 路径不检查 `executedQuantity`，不调用：

- `orderRecorder.recordLocalSell`
- `dailyLossTracker.recordFilledOrder`
- `recordTrade`

#### 风险

- 本地持仓未减，持续高估，影响浮亏计算和智能平仓选单
- 日内已实现亏损偏移缺失，导致风控口径偏宽
- 成交日志缺失，无法对账

#### 修复方向

在 `finalizeOrderClose` 的 CANCELED/REJECTED 路径中，判断 `executedQuantity > 0` 时，补充调用 `recordLocalSell`、`dailyLossTracker.recordFilledOrder`、`recordTrade`，将已成交部分纳入完整结算。与此同时，需要补足 partial-fill 结算所需的买单归属信息，或引入可验证的结算口径；不能假设仅凭当前已记录数量即可精确反推对应的 `relatedBuyOrderIds`。

---

## 重要问题（应修复）

---

### 问题 D：positionLimitChecker 注释与实现不一致，属于注释契约错误

**严重级别**：规范（注释） **涉及文件**：

- `src/core/riskController/positionLimitChecker.ts:63`（`_currentPrice` 参数未使用）
- `src/core/riskController/positionLimitChecker.ts:107`（`checkLimit` 注释与实现不符）

#### 问题描述

`checkLimit` 的 JSDoc 注释（第 107 行）写明：

> 有持仓时优先使用成本价估算市值，**成本价缺失则回退到当前市价**，价格仍无效时仅检查下单金额。

但 `checkWithExistingHoldings` 的实现（第 63 行）：

```typescript
const checkWithExistingHoldings = (
  pos: Position,
  orderNotional: number,
  _currentPrice: number | null, // 下划线前缀：故意未使用
): RiskCheckResult => {
  const price = pos.costPrice;

  if (!Number.isFinite(price) || price <= 0) {
    // 直接跳过，不使用 _currentPrice 作为回退
    return checkOrderNotionalOnly(orderNotional);
  }
  // ...
};
```

`_currentPrice` 接收到参数但从未读取；同时同文件顶部模块说明和实现内注释都明确写的是“已有持仓按成本价估算市值”。二次复核后，当前更准确的结论是：

- **实现与模块级业务口径一致**：现有逻辑就是“仅使用成本价；成本价无效时仅检查下单金额”
- **错误发生在函数注释**：`checkLimit` 的 JSDoc 误写了“回退当前价”的不存在语义

#### 复核结论

- 这是**真实问题**，但问题类型应从“逻辑缺陷”下调为“注释/契约错误”
- 目前没有证据表明仓库内其他业务文档要求这里必须回退到 `currentPrice`
- 因此不应将其表述为已证实的风控失效缺陷

#### 修复方向

优先修正文档而非改逻辑：

1. 删除或改写 `checkLimit` 的误导性注释，明确说明「成本价无效时仅检查下单金额，不使用当前价回退」
2. 若后续业务规格明确要求回退当前价，再单独立项修改实现与测试

---

### 问题 E：配置校验错误契约不完整，Longbridge 凭证缺失不进入 missingFields

**严重级别**：重要 **涉及文件**：

- `src/config/config.validator.ts:194`（`validateLongPortConfig` 返回类型）
- `src/config/config.validator.ts:686`（`validateAllConfig` 中 `allMissingFields` 组装）

#### 问题描述

`validateLongPortConfig`（第 194 行）只返回 `{ valid, errors }`，不含 `missingFields`：

```typescript
function validateLongPortConfig(env: NodeJS.ProcessEnv): Promise<ValidationResult> {
  const errors: string[] = [];
  // ... 检查 LONGPORT_APP_KEY / APP_SECRET / ACCESS_TOKEN
  return Promise.resolve({ valid: errors.length === 0, errors });
  // 无 missingFields 字段
}
```

`validateAllConfig`（第 686 行）组装 `allMissingFields` 时只取 `tradingResult`：

```typescript
const allMissingFields = [...tradingResult.missingFields];
// longPortResult.errors 中的凭证字段名未纳入
```

抛出的 `ConfigValidationError` 的 `missingFields` 中不包含 `LONGPORT_APP_KEY` / `LONGPORT_APP_SECRET` / `LONGPORT_ACCESS_TOKEN`，上层工具链或监控告警无法通过 `missingFields` 进行机器可读诊断。

#### 二次复核验证

定向运行 `bun test tests/config/smartCloseTimeoutConfig.business.test.ts` 后，`includes missing Longbridge credentials in ConfigValidationError.missingFields` 用例实际失败，说明该问题在当前工作区中仍然存在。

#### 修复方向

在 `validateLongPortConfig` 中返回 `missingFields`（格式同 `validateTradingConfig`），在 `validateAllConfig` 中将其合并到 `allMissingFields`。

---

### 问题 F：orderRecorder 刷新链路吞掉异常，重建在损坏数据上无声继续

**严重级别**：重要 **涉及文件**：

- `src/core/orderRecorder/index.ts:386`（`catch` 静默返回空数组）
- `src/main/lifecycle/rebuildTradingDayState.ts:239`（调用方不检查失败）
- `src/main/asyncProgram/monitorTaskProcessor/handlers/seatRefresh.ts:136`（同上）

#### 问题描述

`refreshOrdersFromAllOrdersForLong/Short` 的 `try/catch`（第 386 行）将内部异常静默降级：

```typescript
} catch (error) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  logger.error(`[订单记录失败] 标的 ${symbol}`, errorMessage);
  return Promise.resolve([]);  // 硬失败被替换为空数组
}
```

`rebuildTradingDayState.ts:239` 调用 `rebuildOrderRecords`，后者 `await` 上述函数但不检查返回值，也感知不到内部异常：

```typescript
await rebuildOrderRecords(monitorContexts, allOrders);
// 若内部 catch 了异常，这里不会抛出，重建流程继续
```

后续 `rebuildWarrantRiskCache`、`rebuildUnrealizedLossCache` 均基于空订单数据执行，建立在损坏数据上的风控缓存不触发生命周期重试机制。

`seatRefresh.ts:136` 同理，换标刷新失败被静默吞掉。

#### 二次复核验证

二次复核中已做直接运行验证：当 `refreshOrdersFromAllOrdersForLong` 接收到会在 `classifyOrdersForRebuild` 中触发异常的异常订单快照时，函数会记录错误日志后 `resolve([])`，而不是向上抛出；在此基础上调用 `rebuildTradingDayState`，重建流程仍会成功返回并继续后续步骤。该问题并非纯理论路径。

#### 风险

- 开盘重建在「无订单」假设下继续，牛熊证风险缓存、浮亏缓存均基于错误状态
- 实际持仓所对应的风控约束完全失效，系统却不会告警或重试

#### 修复方向

移除 `refreshOrdersFromAllOrdersForLong/Short` 中的 `try/catch`（或改为重新抛出），让异常向上传播。`rebuildOrderRecords` 应确保任一 symbol 刷新失败时整体抛出，由生命周期管理器的指数退避重试机制处理。

---

### 问题 G：ADX 被错误接入信号生成链路，与权威业务口径不一致

**严重级别**：重要（逻辑偏移） **涉及文件**：

- `src/constants/index.ts:128`（`SIGNAL_CONFIG_SUPPORTED_INDICATORS`）
- `src/config/utils.ts:384`（`isSupportedFixedIndicator` 校验范围）
- `src/config/utils.ts:462`（`parseCondition` 拒绝不支持的指标）
- `src/core/strategy/utils.ts:276`（信号评估层仅支持 `MFI/K/D/J/RSI/PSY`）

#### 问题描述

当前实现一度把 `ADX` 同时接入了“信号生成”和“延迟验证”两条链路，但权威业务口径是：`ADX` **仅用于延迟验证**，**不参与信号生成条件**。

错误点包括：

- `SIGNAL_CONFIG_SUPPORTED_INDICATORS` 把 `ADX` 纳入信号条件固定指标集合
- `parseCondition` 允许解析 `ADX>...` / `ADX<...`
- 策略求值层为 `ADX` 提供了条件可评估性判断与阈值比较分支
- 指标画像会把来自 `signalConfig` 的 `ADX` 编译进 `actionSignalIndicators`

对比之下，`VERIFICATION_FIXED_INDICATORS` 中包含 `ADX` 是正确的，因为 `ADX` 的权威用途就是**延迟验证指标**。

#### 纠偏说明

- `MACD/DIF/DEA/EMA` 仍然保持“仅用于延迟验证”的既有边界
- 本问题的真实范围是：**ADX 从延迟验证专用指标错误外溢到了信号生成链路**
- 若按错误实现配置 `ADX` 信号条件，系统会真的接受并生成信号，这是业务逻辑偏移，而不是单纯文档问题

#### 风险

- 使用 `ADX` 作为 `SIGNAL_*` 条件时，会错误触发买卖信号
- 延迟验证专用指标被混入信号生成，会改变策略触发口径并放大误交易风险

#### 修复方向

- 从 `SIGNAL_CONFIG_SUPPORTED_INDICATORS` 中移除 `ADX`
- 让 `parseCondition` 拒绝 `ADX` 信号条件
- 移除策略求值层对 `ADX` 的信号判断分支
- 保留 `ADX` 在 `VERIFICATION_INDICATORS_*` 与延迟验证器中的支持

---

## 规范问题（建议修复）

---

### 问题 I：部分公共服务契约暴露可变数组，违反 ReadonlyArray 规范

**严重级别**：重要（类型规范） **涉及文件**：

- `src/types/services.ts:367`
- `src/types/services.ts:374`
- `src/types/services.ts:412`
- `src/types/services.ts:418`

#### 问题描述

以下公共接口方法的参数或返回值使用了可变数组，违反仓库 `ReadonlyArray` 规范：

| 位置 | 当前类型 | 应改为 |
| --- | --- | --- |
| `OrderRecorder.refreshOrdersFromAllOrdersForLong` 返回值（:367） | `Promise<OrderRecord[]>` | `Promise<ReadonlyArray<OrderRecord>>` |
| `OrderRecorder.refreshOrdersFromAllOrdersForShort` 返回值（:374） | `Promise<OrderRecord[]>` | `Promise<ReadonlyArray<OrderRecord>>` |
| `Trader.getStockPositions` 参数（:412） | `symbols?: string[] \| null` | `symbols?: ReadonlyArray<string> \| null` |
| `Trader.getStockPositions` 返回值（:412） | `Promise<Position[]>` | `Promise<ReadonlyArray<Position>>` |
| `Trader.getPendingOrders` 参数（:418） | `symbols?: string[] \| null` | `symbols?: ReadonlyArray<string> \| null` |

#### 修复方向

按上表逐项替换，并同步更新镜像契约 `src/core/trader/types.ts` 中相同签名。

---

## 测试缺口（建议补充）

---

### 问题 J：核心策略工厂缺少直接回归测试

**涉及文件**：`src/core/strategy/index.ts:141`（`generateSignal`）

`createHangSengMultiIndicatorStrategy` 中的 `generateSignal` 包含以下关键分支，均无直接单元测试覆盖：

- immediate/delayed 信号分流（`signalTypeMap[action]` 判断）
- 卖出信号必须存在对应买单（`orderRecorder.getBuyOrdersForSymbol` 空值拦截）
- 对象池 `acquireSignal / indicatorRecordPool.acquire` 的 acquire/release 配对路径
- 延迟验证指标列表为空时的提前返回路径

**建议**：在 `tests/core/strategy/` 下新建直接单元测试，覆盖上述分支。

---

### 问题 K：启动门禁 startupGate.wait() 核心行为缺少直接回归测试

**涉及文件**：`src/app/runtime/createPreGateRuntime.ts:71`、`src/main/startup/gate.ts`

现有测试（`tests/app/runApp.test.ts`、`tests/app/startupModes.test.ts`）仅覆盖 RUN_MODE → gatePolicies 的映射关系，未测试 `startupGate.wait()` 的以下行为：

- 非交易日时的轮询等待与重试
- 开盘保护窗口内的等待语义
- `skip` 模式下立即放行
- 超时/异常场景的退出路径

**建议**：在 `tests/main/startup/` 下对 `gate.ts` 的 `wait` 逻辑补充直接单元测试，覆盖各 gate mode 的分支行为。

---

## 附：问题优先级汇总

| 编号 | 问题                                    | 级别         | 是否必须修复 |
| ---- | --------------------------------------- | ------------ | ------------ |
| A    | 卖单合并 relatedBuyOrderIds 占用一致性  | 严重         | 必须         |
| B    | 部分成交后撤单/拒单不落账本             | 严重         | 必须         |
| D    | positionLimitChecker 注释与实现不一致   | 规范（注释） | 建议修复     |
| E    | Longbridge 凭证错误不进入 missingFields | 重要         | 建议修复     |
| F    | orderRecorder 刷新链路吞掉异常          | 重要         | 必须         |
| G    | ADX 被错误用于信号生成条件              | 重要         | 必须         |
| I    | 部分公共服务契约暴露可变数组            | 规范         | 建议修复     |
| J    | 策略工厂缺少直接回归测试                | 测试缺口     | 建议补充     |
| K    | 启动门禁行为缺少直接回归测试            | 测试缺口     | 建议补充     |

---

## 附：暂存修改溯源说明

**审查结论**：二次复核后保留的问题均为此次暂存修改**之前已存在**的缺陷，暂存修改未引入本文件中仍保留的问题。

| 问题 | 暂存文件涉及 | 暂存修改影响 |
| --- | --- | --- |
| A | 是（closeFlow.ts, orderStorage.ts） | 修复了成交后账本精确扣减，REPLACE/CANCEL_AND_SUBMIT 占用集合问题未触及 |
| B | 是（closeFlow.ts） | 仅修改 FILLED 路径顺序，CANCELED/REJECTED 路径完全未触及 |
| D | 否 | 无关 |
| E | 否 | 无关 |
| F | 是（orderRecorder/index.ts, rebuildTradingDayState.ts, seatRefresh.ts） | catch 块静默返回逻辑未改动 |
| G | 是（constants/index.ts） | 当时曾把 ADX 接入信号条件，需按权威业务口径收回为延迟验证专用 |
| I | 是（types/services.ts） | 仅修复 getPendingOrders 返回类型一处，其他签名仍存在可变数组契约 |

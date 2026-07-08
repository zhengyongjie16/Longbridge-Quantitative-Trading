# API 重试错误分类全链路复核记录

**日期:** 2026-05-10

**审查范围:** `wrapExternalApiRequest` 默认重试策略、quote retry 就绪性分类、订单监控撤单/改单/orderDetail 错误码分类，以及相关买卖处理器、末日保护、换标、盯单和启动/重建链路。

## 1. 结论

本次复核确认存在 3 个需要修复的问题：

1. `wrapExternalApiRequest` 的默认 retry 策略过宽：未传 `shouldRetry` 时，除程序错误外的所有错误都会进入有限重试。
2. `quoteRetry` 把“行情缺失/暂未就绪”和“行情已返回但价格逻辑无效”合并成同一种不可就绪结果，多个链路会对无效价格继续调度 quote retry。
3. 订单监控的撤单、改单和 `orderDetail` 查询把“带错误码”作为不可重试边界，可能误伤带错误码的限流或服务端暂态错误。

另有 1 个此前提出的测试风险点在当前生产链路下未确认为实现缺陷：`applyRiskChecks` 顺序遍历中买入 API 异常会中断同批卖出，但当前生产调用只由 `BuyProcessor` 以单个买入信号调用，卖出已由 `SellProcessor` 独立处理，不存在同批买卖被该异常同时阻断的实际链路。

## 2. 第一性原理边界

本系统的重试边界应以“事实能否可靠确认”和“错误是否属于外部暂态”为核心，而不是以“是否抛错”作为唯一依据。

允许重试：

- 网络连接失败、超时、连接重置。
- 外部服务临时不可用。
- 频率限制、限流、服务忙。
- 外部 API 请求本身失败，导致本轮权威事实不可确认。

不允许重试：

- 参数错误、配置错误、非法标的、权限错误。
- API 返回“无候选”“未找到”“订单已终态”“不支持改单”等明确业务事实。
- 已收到行情但价格为 0、负数、NaN 等逻辑无效事实。
- 内部契约错误、状态机不变量错误、本地同步失败。

## 3. 已确认问题

### 3.1 `wrapExternalApiRequest` 默认 retry 策略过宽

**确认状态:** 存在，且需要修复。

**关键位置:**

- `src/utils/apiFailure/index.ts:126-157`
- `src/services/quoteClient/index.ts:77-81`
- `src/services/quoteClient/index.ts:476-520`
- `src/services/quoteClient/index.ts:582-584`
- `src/services/quoteClient/index.ts:609-622`
- `src/services/quoteClient/index.ts:678-723`
- `src/services/autoSymbolFinder/index.ts:143-156`
- `src/core/riskController/warrantRiskChecker.ts:342-345`
- `src/core/trader/accountService.ts:34-38`
- `src/core/trader/accountService.ts:81-85`

**证据链路:**

`wrapExternalApiRequest` 当前逻辑是：

```text
request 抛错
  -> isProgramError(error) 为 true 则 fail-fast
  -> shouldRetry?.(error) === false 则不重试
  -> 其余错误全部进入 retry
  -> retry 耗尽后包装为 ExternalApiRequestError
```

也就是说，只要调用方没有提供 `shouldRetry`，默认行为就是“所有非程序错误均可重试”。当前多个恢复、订阅、自动寻标、轮证信息、账户与持仓读取调用点都直接继承该默认策略。

**全链路影响:**

1. 启动/重建链路：
   - `loadStartupSnapshot` 只要捕获到 `ExternalApiRequestError`，就会进入 `API_RETRY_PENDING`。
   - 如果上游 SDK 将非法标的、权限错误、参数错误、业务拒绝等逻辑错误以普通 `Error` 抛出，当前默认策略会将其包装成 `ExternalApiRequestError`。
   - 结果是本应 fail-fast 的配置或业务事实错误会被误判成外部 API 暂态失败，系统保持静止并等待生命周期重建。

2. 自动寻标与轮证信息链路：
   - `warrantList`、`warrantQuote` 默认重试。
   - 网络失败重试是合理的，但 API 明确返回参数错误、非法标的、权限错误时不应重试。
   - 当前默认策略无法区分这些错误。

3. 账户/持仓链路：
   - 高时效买入前检查已通过 `retryConfig: { retries: 0, delayMs: 0 }` 禁用本地重试。
   - 但启动、成交后一致性、重建等非高时效调用仍使用默认策略。
   - 这些链路允许重试是合理的，但仍应只重试外部暂态错误，不能重试业务逻辑错误。

**为什么需要修复:**

该问题违反“明确的网络、连接、限流、服务端暂态等非逻辑错误才允许重试”的边界。当前代码靠调用方主动传 `shouldRetry` 才能收窄，但默认值本身是开放的，后续新增调用点很容易遗漏分类器。

**修复方向:**

- 将 `wrapExternalApiRequest` 默认策略改为 fail-closed：只有识别为 transient 的错误才重试。
- 建立统一 `isRetryableExternalApiError(error)` 分类器，至少识别：network、timeout、timed out、connection、ECONNRESET、ETIMEDOUT、429、rate limit、temporarily unavailable、service unavailable、5xx 等。
- 对 `not found`、invalid、validation、permission、unsupported、no data、business rejection 等明确非暂态信息默认不重试。
- 允许调用方通过 `shouldRetry` 进一步收窄，但不应让默认策略放宽。

## 4. 已确认问题

### 4.1 `quoteRetry` 未区分缺失行情与无效行情

**确认状态:** 存在，且需要修复。

**关键位置:**

- `src/utils/quoteRetry/index.ts:13-24`
- `src/main/asyncProgram/sellProcessor/index.ts:201-249`
- `src/core/doomsdayProtection/index.ts:295-325`
- `src/services/autoSymbolManager/switchStateMachine.ts:742-759`
- `src/core/trader/orderMonitor/routeProcessor.ts:836-860`
- `src/services/quoteClient/index.ts:208-233`
- `src/services/quoteClient/index.ts:391-439`

**证据链路:**

`isQuoteReadyForRequirement` 当前只返回 boolean：

```text
quote 不存在 -> false
quote.price 非有限数或 <= 0 -> false
PRICE 要求 -> true
PRICE_AND_LOT_SIZE 要求下 lotSize 缺失或无效 -> false
```

调用方看到 `false` 后并不知道失败原因：

- `SellProcessor` 会进入 `resolveNextQuoteRetry` 并通过 timer 重新入队。
- 末日保护会把对应标的加入 `unresolvedSymbols`，由上层继续安排重评估。
- 距离换标状态机会推进 quote retry state。
- 盯单改单链路会推进 quote retry state。

同时，`quoteClient.buildQuoteFromRealtime` 只检查 `lastDone` 是否为有限数，没有检查 `lastDone > 0`。因此从 `getQuotes()` 返回 `Quote` 对象但 `price <= 0` 的情况在当前代码层面可发生。

**全链路影响:**

1. 卖出处理器：
   - 行情缺失时短暂 retry 是合理的。
   - 但如果已经拿到实时行情且价格为 0、负数或 NaN，这不是“等待行情 warm up”，而是数据逻辑异常。
   - 当前会继续重试最多 `ORDER_QUOTE_RETRY.MAX_ATTEMPTS` 次，拖延卖出决策。

2. 末日保护清仓：
   - 末日清仓窗口对时间高度敏感。
   - 如果清仓标的返回无效价格，当前会被归类为 unresolved，而不是明确暴露“收到无效行情”。
   - 这会把数据异常表现为普通未就绪重试，降低问题可观测性。

3. 自动换标移仓卖出：
   - 换标状态机在有可用持仓时需要依赖旧标的实时价格提交移仓卖出。
   - 无效价格继续 quote retry 会让状态机等待，直到 quote retry 耗尽后失败。
   - 更合理的边界是：未收到 quote 可以等；收到无效 quote 应直接进入明确失败或保护性停止。

4. 订单监控改单：
   - 盯单改单依赖最新 quote 决定是否跟价。
   - 无效价格不应被视为“暂时未就绪”，否则会触发 quote retry 状态推进，延迟发现上游行情数据异常。

**为什么需要修复:**

该问题违反“逻辑上的原因，如 API 查找不到符合条件的数据、无效行情，不应允许重试”的原则。缺失 quote 和无效 quote 的业务语义不同：前者是事实未到达，后者是事实到达但不可用。

**修复方向:**

- 将 `isQuoteReadyForRequirement` 从 boolean 改为分类结果，例如：
  - `READY`
  - `MISSING`
  - `INVALID_PRICE`
  - `MISSING_LOT_SIZE`
  - `INVALID_LOT_SIZE`
- 只有 `MISSING` 或明确的 transient 未就绪允许走 `resolveNextQuoteRetry`。
- `INVALID_PRICE` 应直接 skip/fail，并记录明确原因。
- `PRICE_AND_LOT_SIZE` 下，`MISSING_LOT_SIZE` 是否允许 retry 需要按链路确认：若 metadata 尚未初始化可 retry；若订阅准入已保证 metadata 完整，则应 fail-fast 或拒绝执行。
- 同步收紧 `buildQuoteFromRealtime`：`lastDone <= 0` 不应构造成有效 `Quote`。

## 5. 已确认问题

### 5.1 订单错误码分类过窄，可能误伤带 code 的暂态错误

**确认状态:** 存在，且需要修复。

**关键位置:**

- `src/core/trader/orderMonitor/utils.ts:315-332`
- `src/core/trader/orderMonitor/orderOps.ts:281-285`
- `src/core/trader/orderMonitor/orderOps.ts:463-467`
- `src/core/trader/orderMonitor/orderStatusQuery.ts:55-59`
- `src/constants/index.ts:321-333`

**证据链路:**

`isRetryableOrderMutationError` 当前第一步是：

```text
extractErrorCode(err) !== null -> false
```

随后才通过 message 判断 network、timeout、connection、429、rate limit 等暂态关键词。

`orderStatusQuery.checkOrderState` 的 `shouldRetry` 是：

```text
extractErrorCode(error) === null
```

这意味着：

- 无 code + message 命中暂态关键词：可重试。
- 有 code + 明确业务错误码：不可重试，这是正确的。
- 有 code + 429 / rate limit / service unavailable / temporary busy：也不可重试，这是边界过窄。

**全链路影响:**

1. 撤单链路：
   - 撤单 API 遇到网络超时可重试。
   - 但如果 Longbridge 返回带 code 的限流或服务忙，当前不会进入本地有限重试，而是返回 `UNKNOWN_FAILURE` 或后续业务分支。
   - 对撤单这种需要尽快确认状态的链路，这会降低暂态恢复能力。

2. 改单链路：
   - `602012` 不支持改单、`602013` 订单状态暂不允许改单是明确业务错误，应保持不可重试或进入专用退避状态。
   - 但 coded transient 不应与这些业务错误混在“所有带 code 不重试”里。

3. `orderDetail` 权威查询：
   - `603001` order not found 是明确业务事实，需要走确认分支。
   - 但 coded rate limit / service busy / 5xx 暂态错误应允许有限重试。
   - 当前 `extractErrorCode(error) === null` 会直接拒绝所有 coded retry。

**为什么需要修复:**

用户明确允许“限流、服务端暂态”等非逻辑错误重试。错误码存在并不等价于业务错误；一些外部系统会用结构化 code 表达限流、服务忙或服务端错误。

**修复方向:**

- 建立订单 API 错误码分类：
  - business terminal code：`601011`, `601012`, `601013`, `603001`
  - replace unsupported code：`602012`
  - replace temp blocked code：`602013`
  - transient code allowlist：429、5xx、服务忙、临时不可用等，需要结合 Longbridge 文档或真实错误样本确认
- `isRetryableOrderMutationError` 应先判断 transient code，再判断业务 code，而不是“有 code 直接 false”。
- `orderStatusQuery` 的 `shouldRetry` 也应复用同一 transient classifier。
- 没有拿到官方 code catalog 前，修复可先按 message + 常见 HTTP/status code 保守 allowlist 实现，未知 code 仍不重试。

## 6. 未确认为实现缺陷的问题

### 6.1 `applyRiskChecks` 混合批次异常阻断卖出

**确认状态:** 当前生产链路不成立，不作为本次需要修复的问题记录。

**相关位置:**

- `src/core/signalProcessor/riskCheckPipeline.ts:141-291`
- `src/main/asyncProgram/buyProcessor/index.ts:163`
- `src/main/asyncProgram/sellProcessor/index.ts:258`
- `src/main/businessEventProgram/signalPipeline.ts:122-143`

**分析:**

`riskCheckPipeline.applyRiskChecks` 的确按数组顺序处理信号。若某个买入信号在实时账户/持仓 API 读取阶段抛出 `ExternalApiRequestError`，函数会直接向外抛出，不会继续处理数组中后续信号。

但当前生产链路中：

1. 普通信号生成后，`runSignalPipeline` 直接把买入信号放入 `buyTaskQueue`，卖出信号放入 `sellTaskQueue`。
2. `BuyProcessor` 调用 `signalProcessor.applyRiskChecks([signal], riskCheckContext)`，传入的是单个买入信号数组。
3. `SellProcessor` 不调用 `applyRiskChecks`，而是调用 `signalProcessor.processSellSignals(...)`。

因此，不存在生产路径把 `[BUYCALL, SELLCALL]` 混合批次传给 `applyRiskChecks` 的场景。该问题可以作为测试层面的防御性用例讨论，但不属于当前实现缺陷。

**建议:**

- 暂不作为修复项。
- 若未来重新引入批量混合买卖风险检查，应先调整 `applyRiskChecks` 的异常隔离语义或测试固化“异常是否阻断同批无关信号”。

## 7. 推荐修复顺序

1. 先修 `wrapExternalApiRequest` 默认分类，建立统一 transient classifier。
2. 再修订单错误码分类，让订单链路复用同一套 transient/business code 边界。
3. 最后修 `quoteRetry` 返回值结构，把缺失行情与无效行情拆开。
4. 补测试：
   - 默认 API wrapper：业务错误不重试，transient 错误重试。
   - quote retry：missing quote 可 retry，invalid price 不 retry。
   - 订单错误：coded transient 可 retry，coded business 不 retry。
   - 当前生产调用约束：`applyRiskChecks` 只用于单买入信号，可通过架构测试或单元测试固化。

## 8. 验收标准

修复完成后应满足：

- 任意未传 `shouldRetry` 的 API 调用不会默认重试业务逻辑错误。
- `price <= 0`、负数、NaN 的 quote 不会进入 quote retry。
- `603001`、`602012`、`602013` 等业务错误码保持不可普通重试。
- 429、服务忙、暂时不可用等明确暂态错误码或消息允许有限重试。
- 高时效链路仍保持禁重试：买入前实时账户/持仓、执行时 `realtimeQuote`、卖出数量持仓查询、普通下单与超时转市价下单。
- API 暂态失败期间不伪造空事实，不静默吞错，不阻塞无关业务链路。

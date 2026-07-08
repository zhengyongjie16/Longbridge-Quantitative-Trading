# 2026-04-22 Longbridge SDK 4.0.5 升级精确改动清单

> 状态：已实施并通过全量验证  
> 实施前基线：`longbridge@4.0.3`  
> 目标基线：`longbridge@4.0.5`  
> 范围：依赖升级、SDK 上下文创建签名对齐、仓库内测试与文档基线同步  
> 不在范围：`4.0.6` / `Unreleased` 未发布能力接入；内容社区 API 接入；交易逻辑、风控逻辑、策略逻辑重构

## 1. 结论

本次升级的核心不是业务重构，而是**把仓库从 `4.0.3` 的 SDK 创建语义迁移到 `4.0.5` 的同步上下文语义**。

最短正确路径只有三件事：

1. 依赖基线升级到 `longbridge@4.0.5`
2. 把交易链路内以 `ctxPromise` 为中心的异步上下文创建模型改成同步 `ctx`
3. 把行情链路的测试工厂类型从“仅 Promise”改成与 SDK `4.0.5` 一致的“同步创建为主，测试替身可继续 awaitable”

本次实施保持以下边界不扩散：

1. `createTrader()` 顶层门面继续保持 `Promise<Trader>`，只收敛内部 `TradeContext` 注入边界
2. 不把测试改写扩大成新的业务重构，只把原本依赖异步 `ctxPromise` 的时序测试改写到真实仍存在的异步边界

本次方案**不应**做以下事情：

1. 不引入“新老 SDK 双签名兼容层”
2. 不为了保留旧测试写法，在生产代码中继续人为维持 `TradeContext.new(...) -> Promise`
3. 不顺带接入 `ContentContext`、`myTopics`、`createTopic`、`WatchlistSecurity.isPinned`

## 2. 已核实事实

### 2.1 上游版本事实

截至 `2026-04-22`，npm 上 `longbridge` 最新已发布版本是 `4.0.5`。

本次升级相关的已发布变化只有：

1. `4.0.4`
   - 修复 `warrantList()` 返回的 `WarrantInfo` 多个字段错误映射到 `last_done`
   - 这是数据正确性修复，不是接口签名变更
2. `4.0.5`
   - `QuoteContext.new` / `TradeContext.new` / `ContentContext.new` 改为同步创建
   - `memberId()` / `quoteLevel()` / `quotePackageDetails()` 改为异步方法
   - WebSocket 改为 lazy connect
   - OAuth 刷新、连接时延、交易日加载策略有优化

本次**不纳入目标基线**的变化：

1. `4.0.6` 中的 `ContentContext.myTopics(...)` / `createTopic(...)`
2. `main` 分支未发布的 `WatchlistSecurity.is_pinned`
3. `main` 分支未发布的 `QuoteContext` 缓存过期修复 PR `#518`

### 2.2 实施前仓库真实状态

实施前仓库的实际状态如下：

1. `package.json` 当前声明 `longbridge@^4.0.3`
2. `node_modules/longbridge/package.json` 当前实际安装版本为 `4.0.3`
3. 当前仓库直接依赖以下 SDK 能力：
   - `QuoteContext.new(config)`
   - `TradeContext.new(config)`
   - `warrantList(...)`
   - `warrantQuote(...)`
   - `setOnQuote(...)`
   - `setOnCandlestick(...)`
   - `setOnOrderChanged(...)`
4. 当前仓库没有扫描到对以下 `4.0.5` 新异步方法的实际业务使用：
   - `memberId()`
   - `quoteLevel()`
   - `quotePackageDetails()`
5. 当前仓库没有扫描到对以下未发布/未接入能力的业务使用：
   - `ContentContext`
   - `myTopics(...)`
   - `createTopic(...)`
   - `watchlist`

## 3. 升级影响判断

### 3.1 真正会造成编译改动的是 `4.0.5` 的上下文创建签名

当前仓库仍按 `4.0.3` 语义使用：

```text
QuoteContext.new(config) -> Promise<QuoteContext>
TradeContext.new(config) -> Promise<TradeContext>
```

而 `4.0.5` 之后应对齐为：

```text
QuoteContext.new(config) -> QuoteContext
TradeContext.new(config) -> TradeContext
```

因此本次升级的主要改动点不是业务逻辑，而是**上下文装配方式和相关类型边界**。

### 3.2 `4.0.4` 的 `warrantList` 修复目前不是阻塞项

当前自动寻标链路主要消费的是：

1. `callPrice`
2. `toCallPrice`
3. `turnover`
4. `status`

而 `4.0.4` 修复的重点字段是：

1. `strikePrice`
2. `itmOtm`
3. `impliedVolatility`
4. `delta`
5. `effectiveLeverage`
6. `conversionRatio`
7. `balancePoint`

所以这次升级带来的**立即代码改动**并不来自 `4.0.4`，但升级后会顺带拿到这部分数据正确性修复。

## 4. 精确改动清单

### 4.1 必改：依赖基线

#### `package.json`

当前：

```json
"longbridge": "^4.0.3"
```

目标：

```json
"longbridge": "^4.0.5"
```

#### `bun.lock`

目标状态：

1. 锁定到 `longbridge@4.0.5`
2. 所有平台二进制包同步刷新到 `4.0.5`

### 4.2 必改：交易链路从 `ctxPromise` 改为同步 `ctx`

#### 改动原则

`TradeContext.new(config)` 在 `4.0.5` 已经是同步且不可失败的创建行为，因此仓库内不应继续保留“上下文创建 Promise 化”的旧模型。

本次应直接把交易链路的共享依赖从：

```ts
readonly ctxPromise: Promise<TradeContext>;
```

收敛为：

```ts
readonly ctx: TradeContext;
```

并同步删除调用点中的 `await ctxPromise`。

#### 必改文件

生产代码：

1. `src/core/trader/index.ts`
2. `src/core/trader/types.ts`
3. `src/core/trader/accountService.ts`
4. `src/core/trader/orderCacheManager.ts`
5. `src/core/trader/orderExecutor/index.ts`
6. `src/core/trader/orderMonitor/index.ts`
7. `src/core/trader/orderMonitor/orderOps.ts`
8. `src/core/trader/orderMonitor/orderStatusQuery.ts`
9. `src/core/trader/orderMonitor/routeProcessor.ts`
10. `src/core/trader/orderMonitor/types.ts`
11. `src/core/orderRecorder/types.ts`
12. `src/core/orderRecorder/orderApiManager.ts`

精确改法：

1. `createTrader(...)` 内将

```ts
const ctxPromise = TradeContext.new(config);
```

改为

```ts
const ctx = TradeContext.new(config);
```

2. 所有依赖注入字段统一从 `ctxPromise` 重命名为 `ctx`
3. 所有 `await ctxPromise` 改成直接使用 `ctx`
4. 所有注释、JSDoc、参数说明同步改为“Trade API 上下文”而不是“Promise 化的上下文创建结果”

### 4.3 必改：行情链路的工厂类型与 SDK 4.0.5 对齐

行情侧与交易侧不同，当前仓库保留了 `quoteContextFactory` 作为测试替身注入点，因此不应把“生产默认路径同步化”和“测试替身能力”混为一谈。

#### 目标原则

1. 生产默认路径必须按 `4.0.5` 使用同步 `QuoteContext.new(config)`
2. 测试替身注入点可以继续允许 awaitable 返回值
3. 不在生产运行态人为保留旧 SDK 的 Promise 创建语义

#### 必改文件

1. `src/services/quoteClient/index.ts`
2. `src/services/quoteClient/types.ts`

#### 精确改法

`src/services/quoteClient/types.ts`

把：

```ts
readonly quoteContextFactory?: (config: Config) => Promise<QuoteContextLike>;
```

改为：

```ts
readonly quoteContextFactory?: (
  config: Config,
) => QuoteContextLike | Promise<QuoteContextLike>;
```

`src/services/quoteClient/index.ts`

把默认创建路径从：

```ts
(await QuoteContext.new(config)) as QuoteContextLike;
```

改为：

```ts
QuoteContext.new(config) as QuoteContextLike;
```

保留测试注入路径上的 `await quoteContextFactory(config)`，因为这是测试 seam，不是 SDK 兼容层。

### 4.4 必改：测试基线同步

#### 交易链路测试

当前大量测试仍以：

```ts
ctxPromise: Promise.resolve(tradeCtx as unknown as TradeContext);
```

构造依赖。

升级后这批测试必须统一改成同步 `ctx` 注入。

受影响测试范围：

1. `tests/chaos/*.test.ts` 中涉及 `ctxPromise` 的用例
2. `tests/core/orderRecorder/orderApiManager.test.ts`
3. `tests/core/trader/**/*.test.ts`
4. `tests/integration/*flow.integration.test.ts`
5. `tests/integration/auto-symbol-switch.integration.test.ts`
6. `tests/integration/protective-liquidation.integration.test.ts`

精确改法：

1. 所有测试依赖对象字段从 `ctxPromise` 改成 `ctx`
2. 所有 `Promise.resolve(...)` 形式的 TradeContext fixture 改成直接传入对象
3. 原本通过 `ctxPromise` reject / deferred 模拟“创建时不可用”的测试，不能机械改成任意 API 抛错，而要按原语义改写到真实异步边界：
   - “broker 接受前失败必须释放 placeholder” 改为模拟 `rateLimiter.throttle()` 或 `ctx.submitOrder()` 在 broker 接受前失败
   - “旧 continuation 晚到时不得继续提交” 改为延迟 `rateLimiter.throttle()`，而不是继续伪造异步 `ctx`

#### 行情链路测试

当前行情测试多数使用：

```ts
quoteContextFactory: async () => quoteMock;
```

这批测试**可以不强制改写为同步函数**，因为 `quoteContextFactory` 目标类型会改成 awaitable。

受影响测试范围：

1. `tests/services/quoteClient/business.test.ts`
2. `tests/chaos/candlestick-websocket-out-of-order.test.ts`

这两类测试只需要在类型更新后重新通过编译即可；若无可读性需求，不是必须改写。

### 4.5 必改：活文档中的 SDK 使用基线

当前扫描到的仓库内 `await QuoteContext.new(...)` / `await TradeContext.new(...)` 主要位于历史问题记录：

1. `docs/issues/2026-03/2026-03-13-longbridge-openapi-oauth-trade-asset-permission-issue.md`

这类文件属于历史记录，不应为了升级而重写过去的排障快照。

因此本次文档同步边界为：

1. 若是“当前操作指南/当前计划文档/当前 README”，要更新到 `4.0.5` 语义
2. 若是“历史 issue 记录”，保持原样，不做追溯性重写

本次仓库内需要同步的活文档主要就是本计划文档本身，因此实施完成后应回写状态、边界和特殊测试改法，确保文档与最终实现一致。

## 5. 明确不改的部分

### 5.1 不改 `memberId()` / `quoteLevel()` / `quotePackageDetails()`

原因：

1. 当前仓库未实际调用这三个 API
2. 没有调用点，就没有升级适配工作

### 5.2 不改内容社区能力

不接入以下能力：

1. `ContentContext`
2. `myTopics(...)`
3. `createTopic(...)`
4. `topic_detail(...)`
5. `list_topic_replies(...)`
6. `create_topic_reply(...)`

原因：

1. 这些能力未进入当前程序业务闭环
2. 它们不属于 `4.0.3 -> 4.0.5` 升级的最短正确路径

### 5.3 不改历史 issue 文档

以下类型文件保持历史状态：

1. `docs/issues/**`

原因：

1. 它们记录的是当时的真实问题上下文
2. 事后按新 SDK 语义重写，会破坏历史证据链

## 6. 实施顺序

### 步骤 1：升级依赖

1. 修改 `package.json` 到 `^4.0.5`
2. 刷新 `bun.lock`
3. 确认本地安装版本为 `4.0.5`

### 步骤 2：重构交易上下文依赖模型

1. 从 `createTrader(...)` 开始，把根装配点改成同步 `ctx`
2. 自上而下替换 `ctxPromise` 的类型、参数和使用点
3. 删除不再成立的 `await ctxPromise`

### 步骤 3：调整行情工厂类型

1. 默认路径切换到同步 `QuoteContext.new(config)`
2. 保留测试替身工厂的 awaitable 注入能力

### 步骤 4：刷新测试

1. 先改交易链路测试 fixture
2. 再按真实语义重写 `routeProcessor` 中依赖异步 `ctxPromise` 的特殊时序测试
3. 跑 quote/trader 相关测试
4. 最后跑全量 `format`、`lint`、`type-check` 与 `test`

## 7. 验收清单

升级完成后必须满足以下条件：

1. `package.json` 与 `bun.lock` 都指向 `longbridge@4.0.5`
2. 仓库内生产代码不再保留 `ctxPromise: Promise<TradeContext>`
3. 仓库内生产代码默认路径不再 `await QuoteContext.new(config)`
4. `quoteContextFactory` 类型允许同步或异步测试替身
5. `createTrader()` 继续保持现有 async 门面，不额外扩大 public API 变更面
6. `bun format`、`bun lint`、`bun type-check` 通过
7. `bun test` 通过
8. 行情订阅、K 线订阅、订单推送初始化链路不出现新的类型或运行时错误

## 8. 最终范围表

| 文件/范围 | 是否修改 | 修改目的 |
| --- | --- | --- |
| `package.json` | 是 | 升级依赖声明到 `^4.0.5` |
| `bun.lock` | 是 | 刷新锁文件到 `4.0.5` |
| `src/core/trader/index.ts` | 是 | 同步 `TradeContext.new(...)` 创建语义 |
| `src/core/trader/**/*.ts` 中全部 `ctxPromise` 使用点 | 是 | 交易链路去 Promise 化 |
| `src/core/orderRecorder/**/*.ts` 中全部 `ctxPromise` 使用点 | 是 | 交易上下文边界同步 |
| `src/services/quoteClient/types.ts` | 是 | 工厂类型改成 awaitable seam |
| `src/services/quoteClient/index.ts` | 是 | 默认路径切换到同步 `QuoteContext.new(...)` |
| `tests/**` 中所有交易链路 `ctxPromise` fixture | 是 | 测试基线同步到同步 `ctx` |
| `tests/app/runApp.test.ts` / `src/app/runApp.ts` | 是 | 去掉全局模块 mock 串扰，恢复全量测试并发可重复性 |
| `tests/services/quoteClient/**` | 可能 | 仅在类型对齐需要时调整 |
| `docs/issues/**` | 否 | 历史记录不追溯重写 |
| `ContentContext` / 内容社区能力接入 | 否 | 不在本次升级范围 |
| `memberId()` / `quoteLevel()` / `quotePackageDetails()` 调用点 | 否 | 当前仓库没有使用 |

## 10. 实施结果

截至 `2026-04-23`，本次改动已完成并验证：

1. `package.json` 与 `bun.lock` 已升级到 `longbridge@4.0.5`
2. 交易链路生产代码已全部去除 `ctxPromise`
3. 行情链路默认创建路径已切换为同步 `QuoteContext.new(config)`
4. `routeProcessor` 的特殊时序测试已改写到真实异步边界
5. 为消除 `bun test` 全量并发时的历史模块 mock 串扰，`runApp` 装配测试改为显式依赖注入，不再污染其他测试文件

## 9. 参考

1. OpenAPI changelog: `https://github.com/longbridge/openapi/blob/main/CHANGELOG.md`
2. npm package: `https://www.npmjs.com/package/longbridge`
3. `4.0.4` 修复：`https://github.com/longbridge/openapi/pull/485`
4. `4.0.5` 版本标签：`https://github.com/longbridge/openapi/tree/v4.0.5`

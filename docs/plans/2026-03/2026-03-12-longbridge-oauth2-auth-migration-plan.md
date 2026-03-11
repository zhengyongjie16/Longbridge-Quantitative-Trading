# Longbridge OAuth 2.0 认证迁移重构方案

> 日期：2026-03-12
> 
> 范围：Longbridge OpenAPI Node.js SDK 认证层、启动链路、配置校验、辅助脚本、文档与测试
> 
> 目标：将当前项目从旧的 `AppKey/AppSecret/AccessToken` 认证模式，系统性迁移到官方推荐的 OAuth 2.0 认证模式

## 1. 方案结论

本次迁移的正确目标不是“替换几个环境变量”，而是一次认证层的系统性重构。

基于官方文档、官方 SDK 上游代码、当前仓库代码的交叉分析，结论如下：

1. 官方当前推荐的新接入方式已经明确切到 OAuth 2.0。
2. 官方 Node SDK 上游 `4.0.0` 已新增 `OAuth.build(...)` 和 `Config.fromOAuth(...)`，并将旧的 `Config.fromEnv()` 更名为 `Config.fromApikeyEnv()`。
3. 当前仓库仍完整依赖旧认证模型：`longport@3.0.22`、`LONGPORT_*` 环境变量、`new Config({ appKey, appSecret, accessToken })`、旧凭证校验、旧文档、旧测试、旧辅助脚本。
4. 因此正确迁移方案必须满足以下条件：
   1. 升级到官方含 OAuth API 的 `4.x` SDK。
   2. 删除项目内对 `AppKey/AppSecret/AccessToken` 的读取、校验、文档说明与测试断言。
   3. 将启动链路改为“先建立 OAuth 句柄，再构造 SDK Config，再创建 QuoteContext/TradeContext”。
   4. 同批次重写 `.env.example`、README、辅助脚本与测试。
   5. 不保留双认证模式，不做兼容式实现。

这份方案遵守仓库约束：本次只提供系统性重构方案，不给出补丁式或兼容式路径。

## 2. 官方事实依据

### 2.1 OAuth 2.0 已是主流程

官方 OAuth 主流程文档已将 OAuth 2.0 定义为“新接入默认方案”，接入链路为：

1. 注册 OAuth Client。
2. 通过 `/oauth2/authorize` 获取授权码。
3. 通过 `/oauth2/token` 以 `authorization_code` 交换 `access_token`。
4. 调用 API 时使用 `Authorization: Bearer ACCESS_TOKEN`。
5. 通过 `/oauth2/token` 以 `refresh_token` 刷新令牌。

这说明官方已经不再以旧的 `AppKey/AppSecret + AccessToken` 作为推荐认证模型。

### 2.2 Node SDK 4.0 的认证接口已经变化

官方上游 `CHANGELOG.md` 明确写出：

1. `4.0.0` 新增 OAuth 2.0 认证。
2. Node.js 的 `Config.fromEnv()` 改为 `Config.fromApikeyEnv()`。
3. 新增 `OAuth.build(...)`。
4. 新增 `Config.fromOAuth(...)`。
5. 旧 API Key 认证被降级为 legacy / compatibility 模式。

### 2.3 SDK 4.0 的设计含义

从官方 Node SDK 上游接口定义可以得到三个关键结论：

1. OAuth 是先构造 `OAuth` 句柄，再构造 `Config`，不是应用自己手动拼 bearer token 给 SDK。
2. OAuth token 的缓存与复用由 SDK 自身负责，缓存目录在用户目录下。
3. `Config` 对下游 `QuoteContext.new(config)` 与 `TradeContext.new(config)` 的用法不变，因此业务交易/行情主链可以保持稳定，重构重点在认证入口与启动层。

## 3. 当前仓库的真实现状

### 3.1 主程序认证链路

当前主程序的认证主链如下：

1. [src/config/config.index.ts](D:/code/Longbridge-Quantitative-Trading/src/config/config.index.ts:14)
   - `createConfig({ env })` 读取：
   - `LONGPORT_APP_KEY`
   - `LONGPORT_APP_SECRET`
   - `LONGPORT_ACCESS_TOKEN`
   - `LONGPORT_REGION`
   - 之后通过 `new Config({...})` 创建 SDK Config。

2. [src/config/config.validator.ts](D:/code/Longbridge-Quantitative-Trading/src/config/config.validator.ts:194)
   - `validateLongPortConfig(env)` 将上面三个旧凭证字段视为必填项。

3. [src/app/runtime/createPreGateRuntime.ts](D:/code/Longbridge-Quantitative-Trading/src/app/runtime/createPreGateRuntime.ts:47)
   - 先 `validateAllConfig({ env, tradingConfig })`
   - 再 `createConfig({ env })`
   - 再把 `config` 传入 `createMarketDataClient`

4. [src/services/quoteClient/index.ts](D:/code/Longbridge-Quantitative-Trading/src/services/quoteClient/index.ts:266)
   - `QuoteContext.new(config)`

5. [src/core/trader/index.ts](D:/code/Longbridge-Quantitative-Trading/src/core/trader/index.ts:66)
   - `TradeContext.new(config)`

因此，当前系统的认证配置已经贯穿了“启动校验 -> SDK Config -> QuoteContext -> TradeContext”整条主链。

### 3.2 当前仓库的过时点

当前实现不仅“认证方式旧”，还有以下几层过时问题：

1. 环境变量前缀仍是 `LONGPORT_*`，而官方 4.x 已切到 `LONGBRIDGE_*`。
2. [src/config/utils.ts](D:/code/Longbridge-Quantitative-Trading/src/config/utils.ts:25) 仍通过 `LONGPORT_REGION` 人工拼接 `openapi.longportapp.com/.cn` 域名。
3. README 与 `.env.example` 仍指导用户配置旧凭证。
4. 多个测试用例直接断言旧字段名。
5. 辅助脚本直接调用 `Config.fromEnv()` 或旧 SDK 配置模式。

### 3.3 当前辅助脚本与工具链的旧认证依赖

除主程序外，下列脚本也必须同步迁移，否则仓库会同时存在两套认证模式：

1. [utils/getWarrants.js](D:/code/Longbridge-Quantitative-Trading/utils/getWarrants.js:151)
2. [utils/getHistoryOrders.js](D:/code/Longbridge-Quantitative-Trading/utils/getHistoryOrders.js:425)
3. [tools/dailyIndicatorAnalysis/index.ts](D:/code/Longbridge-Quantitative-Trading/tools/dailyIndicatorAnalysis/index.ts:161)
4. [tools/dailyKlineMonitor/index.ts](D:/code/Longbridge-Quantitative-Trading/tools/dailyKlineMonitor/index.ts:176)

这些文件如果不与主程序同批迁移，后续会出现：

1. 主程序需要 OAuth。
2. 工具脚本仍要求旧三元组。
3. 运维与调试流程分裂。
4. 文档无法自洽。

## 4. 迁移目标定义

本次迁移后的目标状态必须明确如下：

1. 项目只保留 OAuth 2.0 认证路径。
2. 项目不再读取 `LONGPORT_APP_KEY`、`LONGPORT_APP_SECRET`、`LONGPORT_ACCESS_TOKEN`。
3. 项目不再维护 `LONGPORT_REGION` 这种项目私有 endpoint 映射。
4. 项目使用官方 SDK 的 `OAuth.build(...)` 建立 OAuth 句柄。
5. 项目使用官方 SDK 的 `Config.fromOAuth(...)` 创建统一 `Config`。
6. `QuoteContext` 和 `TradeContext` 继续接收同一个 SDK `Config`。
7. token 获取、刷新、缓存、复用由官方 SDK 的 OAuth 机制负责。
8. `.env.example`、README、测试、辅助脚本全部只描述 OAuth 2.0。

## 5. 全链路逻辑验证

### 5.1 正确的启动链路

迁移后，启动主链应为：

```text
dotenv / .env.local
  -> createMultiMonitorTradingConfig
  -> validateAllConfig(业务配置 + OAuth 启动配置)
  -> initializeOAuth(env)
  -> createSdkConfigFromOAuth(oauth, env)
  -> QuoteContext.new(config)
  -> TradeContext.new(config)
  -> 后续主程序保持原业务链路
```

这条链路是正确的，原因如下：

1. 业务配置解析与校验仍然发生在启动前，不影响现有运行时风控与策略链。
2. OAuth 初始化发生在创建 SDK `Config` 之前，符合官方 SDK 4.0 设计。
3. `Config` 仍然是下游 `QuoteContext` / `TradeContext` 的统一输入，因此交易与行情主链不会被撕裂成两套上下文模型。
4. 认证方式变化只影响“Config 的生产方式”，不会直接改变交易、风控、策略、监控等业务模块的语义。

### 5.2 为什么不能在 3.x 上做过渡实现

不能在当前 `3.x` 上做“项目层伪 OAuth”过渡，原因如下：

1. 当前 `3.0.22` 类型定义没有 `OAuth` 与 `Config.fromOAuth()`。
2. 如果应用层自己接管 token 交换和刷新，再把某个中间结果硬塞回旧 `Config`，就会偏离官方 4.x 设计。
3. 这样会把本来应由 SDK 承担的 OAuth 生命周期逻辑，错误地搬到项目内部。
4. 最终只会得到一套不可维护的补丁实现，而不是符合官方最新认证模型的系统性方案。

因此，实施前置条件必须是：依赖切换到官方可用的 `4.x` 版本。

### 5.3 为什么不能保留双模式

不能同时保留 OAuth 与旧 API Key 模式，原因如下：

1. 仓库约束明确反对兼容式方案。
2. 启动校验会分裂成两套字段模型。
3. README、`.env.example`、测试与脚本都需要维护双份说明。
4. 业务方和运维方会失去唯一正确的启动方式。
5. 长期看只会留下更多历史包袱。

所以这次方案必须是“一次性切换到 OAuth 2.0”。

## 6. 详细重构方案

### 6.1 依赖升级

#### 6.1.1 目标

将 `longport` 升级到官方支持 OAuth 的 `4.x`。

#### 6.1.2 原因

1. 只有 `4.x` 才提供 `OAuth.build(...)`。
2. 只有 `4.x` 才提供 `Config.fromOAuth(...)`。
3. 只有 `4.x` 的配置模型才与官方文档当前推荐路径一致。

#### 6.1.3 注意事项

截至本方案编写时，仓库本地查询到 npm 最新仍是 `3.0.23`，而上游主分支已写出 `4.0.0` 变更。实施时必须以“官方可用的正式 4.x 发布版本”为准，不应在当前 3.x 上造过渡实现。

### 6.2 认证模块重构

#### 6.2.1 当前问题

[config.index.ts](D:/code/Longbridge-Quantitative-Trading/src/config/config.index.ts:14) 目前同时承担：

1. 读取旧认证字段。
2. 组装 SDK Config。
3. 处理 region/endpoint 拼接。

这三个职责耦合在一起，不适合迁移到 OAuth。

#### 6.2.2 重构目标

将认证拆成两个明确层次：

1. OAuth 初始化层。
2. SDK Config 组装层。

#### 6.2.3 建议的职责拆分

建议新增一组专门的认证模块，例如：

1. `src/config/auth/types.ts`
2. `src/config/auth/utils.ts`
3. `src/config/auth/index.ts`

推荐职责如下：

1. `initializeOAuth({ env, onOpenUrl })`
   - 读取 `LONGBRIDGE_CLIENT_ID`
   - 读取可选 `LONGBRIDGE_CALLBACK_PORT`
   - 调用 `OAuth.build(clientId, onOpenUrl, callbackPort)`
   - 返回 SDK `OAuth` 句柄

2. `createSdkConfigFromOAuth({ oauth, env })`
   - 读取官方支持的非认证扩展项
   - 通过 `Config.fromOAuth(oauth, extra)` 创建 `Config`
   - 不再读取任何旧认证字段

3. `readSdkExtraConfig(env)`
   - 只负责将环境变量映射为 `ExtraConfigParams`
   - 保持纯函数，方便测试

### 6.3 配置模型重构

#### 6.3.1 要删除的旧配置项

必须彻底删除以下项目级认证配置：

1. `LONGPORT_APP_KEY`
2. `LONGPORT_APP_SECRET`
3. `LONGPORT_ACCESS_TOKEN`
4. `LONGPORT_REGION`

#### 6.3.2 要采用的新配置项

建议新的认证必填项仅保留：

1. `LONGBRIDGE_CLIENT_ID`

建议新的可选项为：

1. `LONGBRIDGE_CALLBACK_PORT`
2. `LONGBRIDGE_HTTP_URL`
3. `LONGBRIDGE_QUOTE_WS_URL`
4. `LONGBRIDGE_TRADE_WS_URL`
5. `LONGBRIDGE_LANGUAGE`
6. `LONGBRIDGE_ENABLE_OVERNIGHT`
7. `LONGBRIDGE_PUSH_CANDLESTICK_MODE`
8. `LONGBRIDGE_PRINT_QUOTE_PACKAGES`
9. `LONGBRIDGE_LOG_PATH`

#### 6.3.3 为什么要删除 `LONGPORT_REGION`

不应继续保留项目内部的 region 映射，原因如下：

1. 官方 SDK 4.x 已经支持通过标准 env 或 extra 参数控制 endpoint。
2. 继续自己维护 `LONGPORT_REGION -> URL` 的映射，会让项目行为与官方文档再次偏离。
3. 认证切换后，项目层应尽量减少对 SDK 网络入口的再包装。

因此，新的设计应当是：

1. 默认依赖 SDK 官方默认 endpoint。
2. 如果确有需要，通过官方标准 `LONGBRIDGE_*_URL` 覆盖。
3. 不再在项目内维护私有 region 语义。

### 6.4 启动链路重构

#### 6.4.1 当前顺序

当前 [createPreGateRuntime.ts](D:/code/Longbridge-Quantitative-Trading/src/app/runtime/createPreGateRuntime.ts:30) 的顺序为：

1. 解析交易配置。
2. 校验配置。
3. 创建旧 SDK Config。
4. 创建行情客户端。

#### 6.4.2 重构后的顺序

调整为：

1. 解析交易配置。
2. 校验业务配置与 OAuth 启动配置。
3. 初始化 OAuth。
4. 基于 OAuth 创建 SDK Config。
5. 创建行情客户端。
6. 保持后续 startup gate / run mode / rebuild 逻辑不变。

#### 6.4.3 这样做的原因

1. `validateAllConfig` 仍负责启动前“配置合法性”检查。
2. `initializeOAuth` 只负责授权句柄建立。
3. `createSdkConfigFromOAuth` 只负责 Config 组装。
4. `createMarketDataClient` 与 `createTrader` 不需要知道 OAuth 细节，只继续接收 `Config`。

### 6.5 配置校验层重构

#### 6.5.1 当前问题

[config.validator.ts](D:/code/Longbridge-Quantitative-Trading/src/config/config.validator.ts:194) 目前的 `validateLongPortConfig()` 只认识旧三元组。

#### 6.5.2 重构目标

将其改为仅验证新的 OAuth 启动配置。

#### 6.5.3 新的校验职责

建议改为 `validateLongbridgeOAuthConfig(env)`，职责为：

1. 校验 `LONGBRIDGE_CLIENT_ID` 必填。
2. 校验 `LONGBRIDGE_CALLBACK_PORT` 如有配置必须为合法端口。
3. 校验 `LONGBRIDGE_*_URL` 如有配置必须为合法 URL。
4. 校验 `LONGBRIDGE_LANGUAGE`、`LONGBRIDGE_PUSH_CANDLESTICK_MODE` 等枚举型配置是否合法。
5. 错误结构仍沿用现有 `ConfigValidationError` 与 `missingFields` 机制。

#### 6.5.4 明确删除的校验逻辑

必须删除：

1. 对 `LONGPORT_APP_KEY` 的必填校验。
2. 对 `LONGPORT_APP_SECRET` 的必填校验。
3. 对 `LONGPORT_ACCESS_TOKEN` 的必填校验。
4. 与这些旧字段对应的 placeholder 文案和错误提示。

### 6.6 运行时 `Config` 契约的保持

迁移后，`PreGateRuntime`、`MarketDataClientDeps`、`TraderDeps` 等下游类型中的 `config: Config` 可以继续保留，不必把 OAuth 句柄往下游传。

这是本方案的关键稳定点：

1. OAuth 变化只发生在 Config 生产入口。
2. 下游运行时只关心统一的 SDK `Config`。
3. 行情、交易、恢复、风控主链都不需要感知认证细节。

### 6.7 辅助脚本同步迁移

所有直接使用 SDK 的工具脚本必须一起改为：

1. `OAuth.build(...)`
2. `Config.fromOAuth(...)`
3. 不再调用 `Config.fromEnv()`
4. 不再读取 `LONGPORT_*`

否则仓库会出现“主程序已迁移，脚本仍旧认证”的分裂状态。

### 6.8 文档与模板同步迁移

必须同批修改：

1. [README.md](D:/code/Longbridge-Quantitative-Trading/README.md)
2. [.env.example](D:/code/Longbridge-Quantitative-Trading/.env.example)
3. 任何说明启动配置的流程图与计划文档

文档层必须明确说明：

1. 新认证方式是 OAuth 2.0。
2. 首次启动会触发授权 URL 输出。
3. token 缓存由 SDK 管理。
4. 不再需要 AppKey/AppSecret/AccessToken。

## 7. 首次授权与部署链路分析

### 7.1 首次授权行为

基于官方 SDK 4.0 设计，首次授权链路为：

1. 启动时调用 `OAuth.build(...)`。
2. 若本地存在有效 token cache，则直接复用。
3. 若不存在，则 SDK 生成授权 URL，并通过回调提供给应用。
4. 应用将 URL 打印到日志/终端。
5. 用户在浏览器完成授权。
6. 本地 callback 成功后，SDK 持久化 token。
7. 后续启动直接复用缓存。

### 7.2 对当前项目的影响

这意味着启动阶段要明确支持以下行为：

1. 终端能看到授权 URL。
2. 启动过程在首次授权期间会阻塞等待。
3. 首次授权完成前，程序不能继续进入行情或交易上下文创建。

### 7.3 部署前提

如果生产环境是纯 headless 环境，首次 OAuth 授权会成为运维前提，而不是纯代码问题。

因此实施前必须确认：

1. 生产环境是否允许完成一次浏览器授权。
2. 本地 callback 端口是否可用。
3. token cache 是否能在运行用户目录下稳定持久化。

这不是方案缺陷，而是 OAuth 2.0 本身带来的部署前提变化，必须在实施前确认。

## 8. 受影响文件清单

### 8.1 核心生产代码

1. [src/config/config.index.ts](D:/code/Longbridge-Quantitative-Trading/src/config/config.index.ts)
2. [src/config/config.validator.ts](D:/code/Longbridge-Quantitative-Trading/src/config/config.validator.ts)
3. [src/config/utils.ts](D:/code/Longbridge-Quantitative-Trading/src/config/utils.ts)
4. [src/app/runtime/createPreGateRuntime.ts](D:/code/Longbridge-Quantitative-Trading/src/app/runtime/createPreGateRuntime.ts)
5. [src/services/quoteClient/types.ts](D:/code/Longbridge-Quantitative-Trading/src/services/quoteClient/types.ts)
6. [src/app/types.ts](D:/code/Longbridge-Quantitative-Trading/src/app/types.ts)

### 8.2 辅助脚本

1. [utils/getWarrants.js](D:/code/Longbridge-Quantitative-Trading/utils/getWarrants.js)
2. [utils/getHistoryOrders.js](D:/code/Longbridge-Quantitative-Trading/utils/getHistoryOrders.js)
3. [tools/dailyIndicatorAnalysis/index.ts](D:/code/Longbridge-Quantitative-Trading/tools/dailyIndicatorAnalysis/index.ts)
4. [tools/dailyKlineMonitor/index.ts](D:/code/Longbridge-Quantitative-Trading/tools/dailyKlineMonitor/index.ts)

### 8.3 文档与模板

1. [README.md](D:/code/Longbridge-Quantitative-Trading/README.md)
2. [.env.example](D:/code/Longbridge-Quantitative-Trading/.env.example)

### 8.4 直接受影响测试

1. [tests/config/smartCloseTimeoutConfig.business.test.ts](D:/code/Longbridge-Quantitative-Trading/tests/config/smartCloseTimeoutConfig.business.test.ts)
2. [tests/config/periodicSwitchConfig.business.test.ts](D:/code/Longbridge-Quantitative-Trading/tests/config/periodicSwitchConfig.business.test.ts)
3. [tests/config/autoSearchDistanceConfig.business.test.ts](D:/code/Longbridge-Quantitative-Trading/tests/config/autoSearchDistanceConfig.business.test.ts)
4. [tests/app/runApp.test.ts](D:/code/Longbridge-Quantitative-Trading/tests/app/runApp.test.ts)
5. [tests/app/createLifecycleRuntime.wiring.test.ts](D:/code/Longbridge-Quantitative-Trading/tests/app/createLifecycleRuntime.wiring.test.ts)

## 9. 测试重构策略

### 9.1 认证字段断言测试

需要把以下测试从旧字段断言改为新 OAuth 字段断言：

1. `missingFields` 不再包含旧三元组。
2. `missingFields` 改为断言 `LONGBRIDGE_CLIENT_ID` 等新字段。

### 9.2 `createConfig()` 相关装配测试

当前部分测试把 `createConfig({ env: {} })` 当作“纯同步工厂”使用。迁移后如果 `createConfig` 内部直接调用 `OAuth.build()`，这些测试会失去可测试性。

因此重构必须保证：

1. OAuth 初始化与 Config 组装解耦。
2. 测试可以注入假的 OAuth 句柄或假的 Config 工厂。
3. 单元测试不触发真实浏览器授权流程。

### 9.3 工具脚本与契约测试

凡是直接使用 `Config.fromEnv()` 的地方，都必须改到新 API，并补齐对应测试或运行验证。

## 10. 分阶段实施方案

### 阶段 1：依赖与接口基线切换

目标：

1. 升级 `longport` 到官方可用 `4.x`。
2. 确认 `OAuth.build(...)`、`Config.fromOAuth(...)`、`Config.fromApikeyEnv()` 可用。
3. 修正项目中对 SDK 配置 API 的静态类型依赖。

完成标准：

1. 项目编译层已能识别新 SDK 认证 API。
2. 旧 `Config.fromEnv()` / `new Config({ appKey... })` 被标记为待移除点。

### 阶段 2：认证入口重构

目标：

1. 新建 OAuth 初始化模块。
2. 重写 SDK Config 组装模块。
3. 删除旧凭证读取逻辑。
4. 删除 `LONGPORT_REGION` 映射逻辑。

完成标准：

1. 启动链路只通过 OAuth 构造 Config。
2. 项目不再引用旧认证字段。

### 阶段 3：启动校验与运行时接线重构

目标：

1. 重写 `validateAllConfig` 的认证校验部分。
2. 调整 `createPreGateRuntime` 的启动顺序。
3. 保持 `QuoteContext` / `TradeContext` 下游主链不变。

完成标准：

1. `validateAllConfig` 只校验新 OAuth 启动配置。
2. pre-gate runtime 在 OAuth 完成后再创建市场数据客户端。

### 阶段 4：辅助脚本、文档、模板与测试收口

目标：

1. 迁移工具脚本。
2. 更新 `.env.example` 与 README。
3. 修改测试断言和装配测试。

完成标准：

1. 仓库内不再存在指导用户使用旧认证的文档。
2. 仓库内不再存在依赖旧认证的脚本。
3. 测试基线全部切到 OAuth。

### 阶段 5：验证与验收

目标：

1. 跑完整静态检查与类型检查。
2. 验证首次授权与 token 复用链路。
3. 验证主程序与辅助脚本的一致性。

完成标准：

1. `bun lint` 通过。
2. `bun type-check` 通过。
3. 首次授权链路正确。
4. 再次启动能复用 token cache。
5. 主程序与辅助脚本不再出现旧认证要求。

## 11. 明确禁止项

本次重构必须明确禁止以下做法：

1. 保留旧 `LONGPORT_*` 与新 `LONGBRIDGE_*` 双配置并行。
2. 在应用层自行实现 OAuth token 刷新，再把结果硬塞给旧 SDK Config。
3. 继续保留 `LONGPORT_REGION` 作为项目私有 endpoint 抽象。
4. 只改主程序，不改辅助脚本。
5. 只改代码，不改 `.env.example` 和 README。
6. 通过兼容壳保留旧 `createConfig` 语义。

这些做法都会把迁移变成补丁工程，不符合仓库约束，也不符合官方 4.x 认证设计。

## 12. 验收标准

完成本次迁移后，必须同时满足以下条件：

1. 主程序只支持 OAuth 2.0。
2. 仓库内不再读取 `LONGPORT_APP_KEY`、`LONGPORT_APP_SECRET`、`LONGPORT_ACCESS_TOKEN`。
3. 仓库内不再使用 `LONGPORT_REGION`。
4. SDK Config 统一由 OAuth 构造。
5. `QuoteContext.new(config)` 与 `TradeContext.new(config)` 继续沿统一 `Config` 工作。
6. `.env.example` 与 README 只描述 OAuth 2.0。
7. 辅助脚本与主程序认证方式一致。
8. 相关测试完成迁移。
9. `bun lint` 通过。
10. `bun type-check` 通过。

## 13. 最终结论

这次迁移的逻辑链路是清晰且正确的：

1. 官方推荐 OAuth 2.0。
2. 官方 SDK 4.x 已为 OAuth 2.0 提供正式接口。
3. 当前项目的业务主链真正依赖的是统一 `Config`，而不是旧凭证字段本身。
4. 因此，只要在启动层把“旧凭证生成 Config”改造成“OAuth 生成 Config”，并同步清理配置、测试、文档、脚本，整个系统就可以在不改变业务主链的前提下完成认证层迁移。

所以本次推荐的唯一正确方案是：

“以官方 SDK 4.x 为前置基线，删除项目内所有 AppKey/Secret/AccessToken 认证耦合，建立 OAuth 初始化层与 Config 组装层，沿现有 `Config -> QuoteContext/TradeContext` 主链下发，并同步完成配置校验、辅助脚本、文档模板与测试的全量切换。”

## 14. 参考来源

1. 官方 OAuth 主流程文档  
   https://github.com/longbridge/openapi-website/blob/main/docs/zh-CN/docs/api-reference/how-to-access-api.md

2. 官方 refresh token 文档  
   https://github.com/longbridge/openapi-website/blob/main/docs/zh-CN/docs/api-reference/refresh-token-api.md

3. 官方 Node SDK README  
   https://github.com/longbridge/openapi/blob/main/nodejs/README.md

4. 官方 SDK 变更日志  
   https://github.com/longbridge/openapi/blob/main/CHANGELOG.md

5. 官方 Node OAuth 绑定源码  
   https://github.com/longbridge/openapi/blob/main/nodejs/src/oauth.rs

# 2026-03-13 Longbridge 双认证兼容最小重构方案

> 状态：待实施  
> 范围：认证接入层、配置校验、启动装配、文档  
> 目标：在保持下游业务链路不分叉的前提下，为当前程序恢复对传统 API Key 认证的兼容能力

## 1. 背景与结论

当前仓库已将认证链路完全收敛为 OAuth 单路径：

```text
OAuth.build(...) -> Config.fromOAuth(...) -> QuoteContext / TradeContext
```

但结合当前已验证的问题，官方现阶段并非所有 Trade 相关 API 都已在 OAuth 路径下稳定可用，因此当前程序仍必须具备传统 API Key 认证能力，才能保证完整运行。

这里的目标不是做临时 fallback，也不是在业务模块中散落双分支，而是恢复一个**明确、可诊断、全链路一致**的双认证接入层。

## 2. 第一性原则与约束

本次重构必须满足以下原则：

1. **认证模式必须在启动前确定**
   启动后不允许“OAuth 失败自动切 API Key”这类隐式回退。

2. **单进程只允许一种认证模式**
   同一次程序运行中，QuoteContext 与 TradeContext 必须共享同一认证来源。

3. **下游业务模块不感知认证模式**
   `createMarketDataClient`、`createTrader`、主循环、风控、订单监控等模块继续只依赖统一的 `Config`。

4. **兼容能力必须收敛在认证接入层**
   不允许把 `if oauth / if apikey` 扩散到服务层、核心业务层、策略层。

5. **环境变量命名统一使用 LONGBRIDGE 前缀**
   不恢复 `LONGPORT_*` 历史变量，避免重新引入命名体系混乱。

## 3. 为什么不采用其他方案

### 3.1 不采用运行时自动 fallback

不允许：

```text
先尝试 OAuth -> 某个接口失败 -> 自动切到 API Key
```

原因：

1. 这会把“配置错误”“权限错误”“接口不支持”“官方服务端异常”混为一类
2. 启动日志将无法清晰表达当前程序实际使用哪种认证
3. 同一进程内可能出现 token/cache/订阅上下文来源不一致的问题
4. 故障排查复杂度显著上升

因此，自动 fallback 不是最小实现，而是最危险的实现。

### 3.2 不采用按模块混用认证

不采用：

```text
Quote 用 OAuth，Trade 用 API Key
```

原因：

1. 当前系统设计默认 `Config` 是统一启动输入
2. 一旦拆成双 Config，需要重新审视 `QuoteContext` / `TradeContext` 生命周期边界
3. 会扩散到测试、日志、诊断、文档和未来维护成本
4. 这不是“最小兼容”，而是架构层级升级

因此，本次最小方案只支持：

```text
单进程全局选择 oauth 或 apikey 之一
```

## 4. 最终目标状态

重构完成后，认证启动链路应收敛为：

```text
env
  -> resolveAuthMode
  -> validateAuthConfig(mode, env)
  -> createSdkConfigFromAuth(mode, env)
  -> QuoteContext.new(config)
  -> TradeContext.new(config)
  -> 后续业务链路保持不变
```

关键特征：

1. 启动前显式选择认证模式
2. 启动期统一校验认证配置
3. 业务层只接收一个 `Config`
4. 程序运行期间不切换认证模式

## 5. 认证模式设计

新增显式环境变量：

```env
LONGBRIDGE_AUTH_MODE=oauth
```

允许值：

- `oauth`
- `apikey`

### 5.1 OAuth 模式

必需字段：

- `LONGBRIDGE_CLIENT_ID`

可选字段：

- `LONGBRIDGE_CALLBACK_PORT`

共享 SDK 扩展字段：

- `LONGBRIDGE_HTTP_URL`
- `LONGBRIDGE_QUOTE_WS_URL`
- `LONGBRIDGE_TRADE_WS_URL`
- `LONGBRIDGE_LANGUAGE`
- `LONGBRIDGE_ENABLE_OVERNIGHT`
- `LONGBRIDGE_PUSH_CANDLESTICK_MODE`
- `LONGBRIDGE_PRINT_QUOTE_PACKAGES`
- `LONGBRIDGE_LOG_PATH`

构造方式：

```text
OAuth.build(...) -> Config.fromOAuth(oauth, extra)
```

### 5.2 API Key 模式

必需字段：

- `LONGBRIDGE_APP_KEY`
- `LONGBRIDGE_APP_SECRET`
- `LONGBRIDGE_ACCESS_TOKEN`

共享 SDK 扩展字段与 OAuth 相同。

构造方式：

```text
Config.fromApikey(appKey, appSecret, accessToken, extra)
```

## 6. 为什么 API Key 模式使用 fromApikey(...) 而不是 fromApikeyEnv()

本项目不应直接调用 `Config.fromApikeyEnv()`，而应使用：

```text
Config.fromApikey(appKey, appSecret, accessToken, extra)
```

原因：

1. 当前项目已具备自己的 `.env.local` 读取和配置校验体系
2. 若使用 `fromApikeyEnv()`，认证配置读取会被下沉到 SDK 内部
3. 会破坏当前启动前统一校验、统一报错、统一日志输出的边界
4. 不利于后续对认证模式进行精确诊断

因此，认证字段必须继续由应用层显式读取和校验，再传给 SDK。

## 7. 最小改造范围

本次最小实现只修改以下边界，不触碰下游业务逻辑。

### 7.1 `src/config/auth/types.ts`

当前问题：

- 只表达 OAuth 相关类型

目标：

- 升级为统一认证联合类型

建议结构：

```ts
export type AuthMode = 'oauth' | 'apikey';

export type OAuthAuthConfig = {
  readonly mode: 'oauth';
  readonly clientId: string;
  readonly callbackPort: number | null;
};

export type ApiKeyAuthConfig = {
  readonly mode: 'apikey';
  readonly appKey: string;
  readonly appSecret: string;
  readonly accessToken: string;
};

export type ResolvedAuthConfig = OAuthAuthConfig | ApiKeyAuthConfig;
```

目标收益：

1. 认证模式在类型层具备明确边界
2. 启动装配只需依赖一个统一认证对象

### 7.2 `src/config/auth/utils.ts`

当前问题：

- 仅支持 OAuth 配置读取
- 认证字段与 SDK extra 字段未形成统一解析模型

目标：

新增三类读取能力：

1. `readAuthMode(env)`
2. `readOAuthAuthConfig(env)`
3. `readApiKeyAuthConfig(env)`

并保留：

4. `readSdkExtraConfig(env)`

关键要求：

1. 认证字段与共享 extra 字段分离
2. 不进行隐式模式猜测
3. 只负责解析，不负责业务决策

### 7.3 `src/config/auth/index.ts`

当前问题：

- 仅暴露 OAuth 专用入口

目标：

收敛为一个统一入口，例如：

```ts
createSdkConfigFromAuth(params): Promise<Config>
```

内部行为：

- `mode=oauth` -> `OAuth.build(...)` -> `Config.fromOAuth(...)`
- `mode=apikey` -> `Config.fromApikey(...)`

同时保留 OAuth 的 `onOpenUrl` 回调能力，但仅在 `oauth` 模式下使用。

### 7.4 `src/config/config.validator.ts`

当前问题：

- 仅校验 OAuth 模式

目标：

将 `validateLongbridgeOAuthConfig` 升级为 `validateLongbridgeAuthConfig`

规则必须明确：

1. `LONGBRIDGE_AUTH_MODE` 未配置：直接报错
2. `oauth` 模式下：
   - `LONGBRIDGE_CLIENT_ID` 必填
   - `LONGBRIDGE_CALLBACK_PORT` 若配置则必须合法
3. `apikey` 模式下：
   - `LONGBRIDGE_APP_KEY` 必填
   - `LONGBRIDGE_APP_SECRET` 必填
   - `LONGBRIDGE_ACCESS_TOKEN` 必填
4. 共享 SDK extra 字段继续统一校验
5. 不允许“字段存在则自动猜测模式”

### 7.5 `src/app/runtime/createPreGateRuntime.ts`

当前问题：

- 启动装配写死为 OAuth

目标：

从：

```text
initializeOAuth -> createSdkConfigFromOAuth
```

改为：

```text
createSdkConfigFromAuth
```

此处是主启动链路唯一需要感知认证接入层变更的地方。

### 7.6 文档同步范围

必须同步更新：

1. `.env.example`
2. `README.md`
3. `docs/others/longbridge-oauth-client-registration-and-authorization-guide.md`

要求：

1. `.env.example` 同时给出 `oauth` 与 `apikey` 两套示例
2. `README.md` 明确说明当前系统支持两种认证模式，且运行时只能选一种
3. OAuth 指引文档必须降级为“OAuth 专用操作文档”，不再表述为唯一认证入口

## 8. 明确不改动的部分

本次最小方案不修改以下内容：

1. `QuoteContext` / `TradeContext` 下游业务调用逻辑
2. 行情客户端、交易客户端、风控、订单监控、主循环
3. 任何“按 API 能力自动切认证”的策略
4. 任何“同一进程内 Quote 用 OAuth、Trade 用 API Key”的混合架构
5. 历史 `LONGPORT_*` 环境变量兼容

这五类都超出“最小兼容实现”边界。

## 9. 实施顺序

### 阶段 1：恢复认证抽象

1. 设计统一认证模式类型
2. 增加认证模式解析函数
3. 增加 API Key 配置解析函数
4. 保留共享 SDK extra 配置解析函数

### 阶段 2：统一 Config 工厂

1. 用统一入口创建 `Config`
2. OAuth 与 API Key 分支都在此收敛
3. 对外只暴露统一 `Config`

### 阶段 3：启动链路接入

1. 启动装配切换为统一认证工厂
2. 删除启动层对 OAuth 专用入口的依赖

### 阶段 4：配置校验升级

1. 引入 `LONGBRIDGE_AUTH_MODE`
2. 按模式校验字段
3. 输出机器可读的 `missingFields`

### 阶段 5：文档更新

1. `.env.example`
2. `README.md`
3. OAuth 指引文档

### 阶段 6：验证

1. lint
2. type-check
3. 双模式启动验证

## 10. 验收标准

重构完成后，必须同时满足以下标准：

1. `oauth` 模式下，配置完整时可正常启动
2. `apikey` 模式下，配置完整时可正常启动
3. `oauth` 模式缺少 `LONGBRIDGE_CLIENT_ID` 时，启动前明确失败
4. `apikey` 模式缺少三元组任一项时，启动前明确失败
5. 下游业务代码不感知认证模式
6. 仓库内不存在“启动后自动 fallback 到另一认证模式”的逻辑
7. `.env.example` 和 `README.md` 与代码行为一致
8. `bun lint` 与 `bun type-check` 全部通过

## 11. 风险分析

### 风险 1：模式判断歧义

如果不引入显式 `LONGBRIDGE_AUTH_MODE`，而改成“看哪个字段存在就走哪个模式”，一旦用户同时保留两套配置，程序行为将不可预测。

处理策略：

- 必须引入显式模式字段

### 风险 2：认证分支扩散

如果在业务模块中传播认证模式判断，后续维护成本会迅速上升。

处理策略：

- 认证兼容只允许存在于接入层

### 风险 3：误用 SDK 的 fromApikeyEnv()

若直接依赖 SDK 从环境变量读取，会破坏本项目现有的配置校验和日志边界。

处理策略：

- 仅使用 `Config.fromApikey(...)`

### 风险 4：未来再次出现能力差异

官方后续可能继续存在“OAuth 支持不完整、API Key 可用”的阶段性差异。

处理策略：

- 用全局认证模式保持确定性
- 不引入自动 fallback
- 把模式切换留给部署配置，而不是运行时推断

## 12. 方案结论

本次最小实现的正确路径不是补丁式兼容，而是恢复一个**显式认证模式 + 统一 Config 工厂 + 下游无感知**的认证接入层。

最终方案结论如下：

1. 引入 `LONGBRIDGE_AUTH_MODE=oauth|apikey`
2. 单进程只允许选择一种认证模式
3. 统一由应用层读取并校验认证配置
4. OAuth 使用 `OAuth.build(...) + Config.fromOAuth(...)`
5. API Key 使用 `Config.fromApikey(...)`
6. 下游 Quote/Trade/业务模块继续只依赖统一 `Config`
7. 不做运行时 fallback
8. 不做 Quote/Trade 混合认证

这是当前仓库在“最小改造成本”和“长期可维护性”之间逻辑最正确、边界最清晰的方案。

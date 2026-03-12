# Longbridge OAuth 2.0 + SDK 包名迁移重构方案（修订版）

> 修订日期：2026-03-12  
> 范围：Longbridge OpenAPI Node.js SDK 认证层、依赖基线、启动链路、配置校验、辅助脚本、测试、Mock、文档与技能知识库  
> 目标：从旧的 `longport + AppKey/AppSecret/AccessToken` 模型，系统性迁移到 `longbridge + OAuth 2.0` 单一路径

## 1. 修订结论

本次重构不是“改几个环境变量”，而是两条主线必须同时完成：

1. SDK 包名与依赖基线迁移：`longport` -> `longbridge`
2. 认证模型迁移：`AppKey/AppSecret/AccessToken` -> `OAuth 2.0`

若只做认证迁移而不做包名迁移，或只改主程序不改测试/Mock/工具链，都会导致仓库长期分裂，无法形成单一正确基线。

## 2. 已核实的官方事实（2026-03-12）

### 2.1 npm 发行现状

1. `longbridge` 最新稳定版是 `4.0.0`
2. `longport` 最新版仍是 `3.0.23`

这意味着 Node SDK 的 4.x 能力在 npm 上已经通过 `longbridge` 包发布，而不是在 `longport` 包上发布。

### 2.2 官方 Node README 已切换到 longbridge

官方 `nodejs/README.md` 明确使用：

1. `npm install longbridge`
2. `require('longbridge')`
3. `OAuth.build(...)`
4. `Config.fromOAuth(...)`
5. 同时保留 `Config.fromApikeyEnv()`（legacy API key 路径，属于 SDK 的兼容能力）

但本项目重构目标是“单一路径 OAuth”，实施与验收阶段禁止采用 API Key 认证分支。

### 2.3 CHANGELOG 的 4.0.0 关键信息

官方 `CHANGELOG.md` 对 4.0.0 明确给出：

1. 新增 OAuth 2.0 认证
2. Node.js `Config.fromEnv()` 改为 `Config.fromApikeyEnv()`
3. OAuth token 持久化与复用由 SDK 内部机制负责

## 3. 当前仓库真实现状（本地扫描）

### 3.1 依赖与锁文件

1. `package.json` 当前同时依赖 `longbridge@^4.0.0` 与 `longport@^3.0.23`（双依赖并存）
2. `bun.lock` 当前同时锁定 `longbridge@4.0.0` 与 `longport@3.0.23`

### 3.2 主程序认证链路仍是旧三元组

1. `src/config/config.index.ts`
   1. 读取 `LONGPORT_APP_KEY / LONGPORT_APP_SECRET / LONGPORT_ACCESS_TOKEN / LONGPORT_REGION`
   2. 使用 `new Config({ appKey, appSecret, accessToken })`
2. `src/config/config.validator.ts`
   1. `validateLongPortConfig` 强制校验旧三元组
3. `src/config/utils.ts`
   1. 维护 `LONGPORT_REGION -> longportapp.com/.cn` 私有映射
4. `src/app/runtime/createPreGateRuntime.ts`
   1. `validateAllConfig -> createConfig -> createMarketDataClient`

### 3.3 工具脚本仍调用旧接口

1. `utils/getWarrants.js` 使用 `Config.fromEnv()`
2. `utils/getHistoryOrders.js` 使用 `Config.fromEnv()`
3. `tools/dailyIndicatorAnalysis/index.ts` 与 `tools/dailyKlineMonitor/index.ts` 依赖 `createConfig({ env })`（当前仍旧三元组）

### 3.4 影响范围远超旧文档清单

全仓扫描结果显示：

1. `from 'longport'` 出现在约 85 个源码/测试文件中
2. 在 `src/tests/mock/tools/utils` 范围内，`longport` 关键字匹配约 208 处，涉及约 96 个文件
3. 覆盖 `src/`、`tests/`、`mock/`、`tools/`、`utils/` 多个层面

因此，旧版计划中“受影响文件清单”明显偏小，不足以指导完整落地。

## 4. 迁移目标（最终状态定义）

迁移完成后，必须同时满足：

1. 项目依赖只使用 `longbridge`，不再依赖 `longport`
2. 代码导入只使用 `from 'longbridge'`
3. 项目只保留 OAuth 2.0 认证路径
4. 项目不再读取 `LONGPORT_APP_KEY / LONGPORT_APP_SECRET / LONGPORT_ACCESS_TOKEN / LONGPORT_REGION`
5. 不再维护私有 `LONGPORT_REGION -> longportapp.*` 端点映射；端点能力仅使用官方 `LONGBRIDGE_*_URL`
6. 启动链路改为 `OAuth.build(...) -> Config.fromOAuth(...) -> QuoteContext/TradeContext`
7. 主程序、工具脚本、测试、Mock、文档统一到同一认证模型
8. `.env.example` 与 README 仅描述 OAuth 启动方式
9. 不保留双模式、不做兼容壳

## 5. 目标启动链路

```text
dotenv / .env.local
  -> createMultiMonitorTradingConfig
  -> validateAllConfig(业务配置 + OAuth 启动配置)
  -> initializeOAuth(env)
  -> createSdkConfigFromOAuth(oauth, env)
  -> QuoteContext.new(config)
  -> TradeContext.new(config)
  -> 后续业务链路保持不变
```

关键原则：

1. 认证变化仅发生在 Config 生产入口
2. 下游继续只依赖统一 `Config`
3. OAuth token 生命周期由 SDK 负责，不在应用层重复实现

## 6. 详细重构范围（修订后）

### 6.1 依赖基线与锁文件

必须修改：

1. `package.json`
   1. 移除 `longport`
   2. 引入 `longbridge@^4.0.0`（或实施时官方最新 4.x）
2. `bun.lock`
   1. 同步刷新到 `longbridge` 依赖树

### 6.2 全仓导入路径迁移

必须全量替换：

1. `from 'longport'` -> `from 'longbridge'`
2. 包括但不限于：
   1. 生产代码 `src/**`
   2. 测试代码 `tests/**`
   3. Mock 基础设施 `mock/longport/**`（目录命名与引用路径需同步迁移）
   4. 工具 `tools/**` 与 `utils/**`

### 6.3 认证模块重构

必须新增认证专属模块：

1. `src/config/auth/types.ts`
2. `src/config/auth/utils.ts`
3. `src/config/auth/index.ts`

推荐职责：

1. `initializeOAuth({ env, onOpenUrl })`
   1. 读取 `LONGBRIDGE_CLIENT_ID`
   2. 读取可选 `LONGBRIDGE_CALLBACK_PORT`
   3. 调用 `OAuth.build(clientId, onOpenUrl, callbackPort)`
2. `createSdkConfigFromOAuth({ oauth, env })`
   1. 读取官方支持的 `LONGBRIDGE_*` 扩展项
   2. 调用 `Config.fromOAuth(oauth, extra)`
3. `readSdkExtraConfig(env)`
   1. 将 env 映射到 `ExtraConfigParams`
   2. 保持纯函数，便于单测
4. 废弃同步 `createConfig({ env })` 入口，并改为“仅在 OAuth 初始化完成后由上层传入 `oauth` 生成 Config”，避免隐式触发授权副作用

### 6.4 配置模型重构

#### 删除项

1. `LONGPORT_APP_KEY`
2. `LONGPORT_APP_SECRET`
3. `LONGPORT_ACCESS_TOKEN`
4. `LONGPORT_REGION`

#### 新项

必填：

1. `LONGBRIDGE_CLIENT_ID`

可选（按官方 4.x 能力）：

1. `LONGBRIDGE_CALLBACK_PORT`
2. `LONGBRIDGE_HTTP_URL`
3. `LONGBRIDGE_QUOTE_WS_URL`
4. `LONGBRIDGE_TRADE_WS_URL`
5. `LONGBRIDGE_LANGUAGE`
6. `LONGBRIDGE_ENABLE_OVERNIGHT`
7. `LONGBRIDGE_PUSH_CANDLESTICK_MODE`
8. `LONGBRIDGE_PRINT_QUOTE_PACKAGES`
9. `LONGBRIDGE_LOG_PATH`

### 6.5 配置校验层重构

将 `validateLongPortConfig` 重构为仅校验 OAuth 启动配置（命名为 `validateLongbridgeOAuthConfig`）：

1. `LONGBRIDGE_CLIENT_ID` 必填
2. `LONGBRIDGE_CALLBACK_PORT`（若存在）必须为合法端口
3. `LONGBRIDGE_*_URL`（若存在）必须为合法 URL
4. 枚举值（`LANGUAGE`、`PUSH_CANDLESTICK_MODE` 等）必须合法
5. 布尔值（`ENABLE_OVERNIGHT`、`PRINT_QUOTE_PACKAGES`）必须合法
6. 保留现有 `ConfigValidationError + missingFields` 契约

### 6.6 启动链路改造

`createPreGateRuntime` 顺序调整为：

1. 解析交易配置
2. 配置校验（业务 + OAuth）
3. 初始化 OAuth
4. 基于 OAuth 生成 SDK Config
5. 初始化行情客户端

`createTrader`、`createMarketDataClient` 下游保持 `config: Config` 不变。

### 6.7 工具脚本改造

以下脚本需同步切换到 `longbridge + OAuth`：

1. `utils/getWarrants.js`
2. `utils/getHistoryOrders.js`
3. `tools/dailyIndicatorAnalysis/index.ts`
4. `tools/dailyKlineMonitor/index.ts`

不得保留 `Config.fromEnv()`。

### 6.8 测试与 Mock 改造

必须覆盖：

1. 旧三元组断言测试改为 `LONGBRIDGE_CLIENT_ID` 等新字段断言
2. 所有 `from 'longport'` 导入切换为 `from 'longbridge'`
3. `mock.module('longport', ...)` 同步改为 `mock.module('longbridge', ...)`
4. `mock/longport/**` 的目录与引用路径统一迁移
5. `tests/app/runApp.test.ts`、`tests/app/createLifecycleRuntime.wiring.test.ts` 等 `createConfig({ env: {} })` 用例改为注入测试用 `Config` 替身，避免真实 OAuth 授权副作用

### 6.9 文档与技能知识库

必须同步更新：

1. `README.md`
2. `.env.example`
3. `docs/plans/**` 中仍引用旧认证路径的计划文档（至少标注过时）
4. `.codex/skills/longport-nodejs-sdk/**`
5. `.claude/skills/longport-nodejs-sdk/**`

否则后续开发会继续被旧知识误导。

## 7. 分阶段实施（修订版）

### 阶段 1：依赖与编译基线切换

目标：

1. `longport` -> `longbridge`
2. 刷新 lockfile
3. 先达成“可编译基线”

完成标准：

1. 依赖树中不再出现 `longport`
2. TypeScript 识别并仅使用 `OAuth.build / Config.fromOAuth` 认证链路

### 阶段 2：全仓导入迁移

目标：

1. 全量替换导入包名
2. 修复因类型差异产生的编译错误

完成标准：

1. 仓库内无 `from 'longport'`

### 阶段 3：认证入口与配置校验迁移

目标：

1. 引入 OAuth 初始化层
2. 移除/替换同步 `createConfig` 入口，避免在无显式授权上下文时触发 OAuth
3. 删除旧凭证读取与校验

完成标准：

1. 运行时链路只使用 OAuth 生成 Config
2. `LONGPORT_*` 认证键不再被读取
3. 测试与工具链不再通过 `createConfig({ env: {} })` 隐式构造真实认证配置

### 阶段 4：工具、测试、Mock 收口

目标：

1. 工具脚本切换到 OAuth
2. 测试与 mock 统一到 `longbridge`

完成标准：

1. 主程序与工具链认证一致
2. 测试不依赖旧包名/旧凭证

### 阶段 5：文档与知识库收口

目标：

1. README/.env 仅描述新路径
2. skills 文档不再给出旧 API 示例

完成标准：

1. 对内对外文档均为单一正确路径

### 阶段 6：验证与验收

目标：

1. 静态与类型检查
2. 首次 OAuth 授权与 token 复用验证
3. 主程序 + 工具脚本一致性验证

完成标准：

1. `bun lint` 通过
2. `bun type-check` 通过
3. 首次授权可完成
4. 二次启动可复用 token cache

## 8. 禁止项

1. 保留 `longport` 与 `longbridge` 双依赖并存
2. 保留 `from 'longport'` 导入残留
3. 保留 `LONGPORT_*` 与 `LONGBRIDGE_*` 双配置并行
4. 在应用层自行实现 OAuth 刷新并绕过 SDK
5. 只改主程序不改测试/Mock/工具/文档/skills
6. 继续维护私有 `LONGPORT_REGION` 域名映射并绕开 SDK 官方 `LONGBRIDGE_*_URL` 机制
7. 在项目业务代码中继续使用 `Config.fromApikeyEnv()` 或 `Config.fromApikey(...)`（禁止 API Key 认证分支）
8. 继续读取 `LONGBRIDGE_APP_KEY / LONGBRIDGE_APP_SECRET / LONGBRIDGE_ACCESS_TOKEN`

## 9. 验收标准（最终）

必须全部满足：

1. `package.json` 与 `bun.lock` 已完全切到 `longbridge`
2. 仓库内不存在 `from 'longport'`
3. 仓库内不存在 `Config.fromEnv()` 调用
4. 仓库内不存在 `LONGPORT_APP_KEY / LONGPORT_APP_SECRET / LONGPORT_ACCESS_TOKEN / LONGPORT_REGION` 读取
5. 主程序与工具脚本统一使用 OAuth 2.0
6. README 与 `.env.example` 仅描述 OAuth 2.0 + `LONGBRIDGE_*`
7. 仓库内不再存在私有 `getRegionUrls` 这类 `longportapp.*` 端点映射逻辑
8. 仓库内不存在 `Config.fromApikeyEnv()` 与 `Config.fromApikey(...)` 调用
9. 仓库内不存在 `LONGBRIDGE_APP_KEY / LONGBRIDGE_APP_SECRET / LONGBRIDGE_ACCESS_TOKEN` 读取
10. `bun lint`、`bun type-check` 全通过

## 10. 参考来源

1. 官方 Node SDK README  
   https://github.com/longbridge/openapi/blob/main/nodejs/README.md

2. 官方 CHANGELOG（4.0.0）  
   https://github.com/longbridge/openapi/blob/main/CHANGELOG.md

3. npm `longbridge` 4.0.0 发行页  
   https://www.npmjs.com/package/longbridge

4. npm `longport` 3.0.23 发行页  
   https://www.npmjs.com/package/longport

5. 官方 OAuth 接入文档  
   https://open.longbridge.com/zh-CN/docs

6. 官方 v3 -> v4 迁移说明（Node：包名与认证接口变更）  
   https://open.longbridge.com/docs/advanced/v3_to_v4

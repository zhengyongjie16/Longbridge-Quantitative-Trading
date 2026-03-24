# 2026-03-21 Longbridge SDK 4.0.3 升级代码改动方案

> 状态：待实施  
> 当前基线：`longbridge@4.0.0`  
> 目标基线：`longbridge@4.0.3`  
> 范围：依赖基线、认证注释与文档、仓库知识基线、升级验收  
> 不在范围：交易逻辑、风控逻辑、策略逻辑重构；`4.0.2` 新内容 API 的业务接入

## 1. 结论

基于当前仓库代码与官方最新 SDK 变更的对比，本次升级不应被定义为业务重构，而应被定义为一次**依赖基线与认证接入基线同步**。

原因很明确：

1. 当前仓库已经使用官方 `4.x` 正确的认证链路：

```text
OAuth.build(...) -> Config.fromOAuth(...)
Config.fromApikey(...)
QuoteContext.new(config)
TradeContext.new(config)
```

2. 当前 `src/` 代码中没有扫描到旧的 `openapi.longbridgeapp.com` 或 `longportapp.cn` 硬编码。
3. `4.0.3` 的核心变化不是交易接口重构，而是 OAuth 基础域名、国内 endpoint 域名和 token 缓存目录迁移。
4. `4.0.2` 虽然新增了 `ContentContext`、`topics(symbol)`、`news(symbol)`、`QuoteContext.filings(symbol)`，但当前仓库并未使用这些能力；在本次升级中主动接入它们会偏离需求。

因此，本次方案的最短正确路径是：

1. 将依赖从 `4.0.0` 升到 `4.0.3`
2. 同步仓库内所有仍然指向旧 token 缓存目录或旧版本描述的注释与文档
3. 保持业务代码结构不变
4. 通过编译、测试和 OAuth 启动链路完成验收

## 2. 已核实事实

### 2.1 官方版本事实

截至 `2026-03-21`，官方 npm 最新版为 `longbridge@4.0.3`。

`4.0.x` 版本序列的有效变化可收敛为：

1. `4.0.1`
   - 主要为 Python 侧修复
   - 对当前 Node.js / TypeScript 仓库无直接 API 面变化
2. `4.0.2`
   - 新增内容资讯相关能力
   - 包括 `ContentContext`、`topics(symbol)`、`news(symbol)`、`QuoteContext.filings(symbol)`
3. `4.0.3`
   - OAuth 基础域名迁移到 `openapi.longbridge.com`
   - 中国区 endpoint 从 `longportapp.cn` 迁移到 `longbridge.cn`
   - OAuth token 缓存目录从 `~/.longbridge-openapi/` 迁移到 `~/.longbridge/openapi/`

### 2.2 当前仓库真实状态

当前仓库的依赖与接入状态如下：

1. `package.json` 仍声明 `longbridge@^4.0.0`
2. `bun.lock` 当前锁定为 `longbridge@4.0.0`
3. 认证工厂已经使用：
   - `OAuth.build(...)`
   - `Config.fromOAuth(...)`
   - `Config.fromApikey(...)`
4. `src/` 内未发现旧 Longbridge 域名硬编码
5. `README.md` 与 `.env.example` 中示例 endpoint 已经是新域名
6. 仓库内仍存在少量旧 token 缓存目录说明，需要同步

## 3. 第一性原则与边界

本次升级方案必须遵守以下边界：

1. 不做兼容性补丁方案  
   不在应用代码内新增“同时兼容旧 token 目录和新 token 目录”的双路径逻辑。

2. 不做超范围能力接入  
   不因 `4.0.2` 新增了 `news/topics/filings` 就顺带把资讯能力引入交易系统。

3. 不动下游业务链路  
   `QuoteContext`、`TradeContext` 的创建方式已经符合官方 `4.x` 使用方式，本次不应把 SDK 升级误扩成行情、下单、风控重构。

4. 文档与代码基线必须一致  
   依赖升级后，仓库注释、操作文档、内部知识参考不能继续保留 `4.0.0` 或旧 token 目录表述。

## 4. 当前仓库的受影响点分析

### 4.1 必改：依赖基线

#### `package.json`

当前问题：

```text
"longbridge": "^4.0.0"
```

目标状态：

```text
"longbridge": "^4.0.3"
```

原因：

1. 仓库声明基线必须与目标升级版本一致
2. 后续安装和 CI 不应继续回落到 `4.0.0`

#### `bun.lock`

当前问题：

```text
longbridge@4.0.0
```

目标状态：

```text
longbridge@4.0.3
```

原因：

1. 锁文件必须反映真实安装版本
2. 这是升级生效的必要条件

### 4.2 必改：代码注释基线

#### `src/config/auth/utils.ts`

当前问题：

`readSdkExtraConfig` 的注释仍写着“当前 Node SDK `4.0.0` 已确认支持的 extra 字段”。

这在升级后会变成错误表述，因为仓库基线已不再是 `4.0.0`。

目标状态：

将该注释改为不绑定具体补丁版本的表达，例如：

```text
当前 Node SDK 4.0.x 已确认支持的 extra 字段
```

原因：

1. 这里是仓库源码注释，不应在升级后继续保留旧版本描述
2. 改为 `4.0.x` 能避免后续补丁版本升级再次产生注释漂移

### 4.3 必改：OAuth 操作文档

#### `docs/others/longbridge-oauth-client-registration-and-authorization-guide.md`

当前问题：

该文档多处仍指向旧 token 缓存目录：

```text
%USERPROFILE%\.longbridge-openapi\tokens\<client_id>
```

目标状态：

统一改为 `4.0.3` 对应的新目录表达：

```text
%USERPROFILE%\.longbridge\openapi\tokens\<client_id>
```

原因：

1. 升级后若仍保留旧路径说明，会直接误导排障与验收
2. 这份文档明确覆盖首次授权和 token 验证流程，必须与新 SDK 一致

### 4.4 建议改：仓库内部知识基线

#### 已删除的内部 skill 路径（历史说明）

当前问题：

该技能参考文件仍写着旧 token 缓存路径：

```text
~/.longbridge-openapi/tokens/<client_id>
```

目标状态：

更新为：

```text
~/.longbridge/openapi/tokens/<client_id>
```

原因：

1. 这是仓库内置知识基线的一部分
2. 若不改，后续基于该 skill 的分析会继续引用过时信息

说明：

这不是运行时代码，但它属于仓库知识基线；若本次实施包含文档同步，建议一并改正。

### 4.5 明确不改的文件

#### `README.md`

当前状态已正确使用：

1. `https://openapi.longbridge.com`
2. `wss://openapi-quote.longbridge.com/v2`
3. `wss://openapi-trade.longbridge.com/v2`

因此本次升级不应为 README 强行制造改动。

#### `.env.example`

当前示例 endpoint 已与官方 `4.0.3` 基线一致，因此不改。

#### `src/config/auth/index.ts`

当前已经使用：

1. `OAuth.build(...)`
2. `Config.fromOAuth(...)`
3. `Config.fromApikey(...)`

这是官方 `4.x` 正确用法，本次升级不改认证工厂结构。

#### `src/services/**`、`src/core/**`

当前没有证据表明 `4.0.3` 对行情、交易、风控、订单监控调用签名产生破坏性变更，因此本次不改下游业务实现。

## 5. 最终改动范围

本次升级的最终改动范围应收敛为下表。

| 文件 | 是否修改 | 修改目的 |
| --- | --- | --- |
| `package.json` | 是 | 升级依赖声明到 `^4.0.3` |
| `bun.lock` | 是 | 刷新锁文件到 `4.0.3` |
| `src/config/auth/utils.ts` | 是 | 修正源码注释中的旧版本表述 |
| `docs/others/longbridge-oauth-client-registration-and-authorization-guide.md` | 是 | 修正 OAuth token 新缓存目录 |
| 已删除的内部 longbridge skill 文档路径 | 否 | 相关 skill 文档已移除，本步骤不再适用 |
| `README.md` | 否 | 当前 endpoint 已正确 |
| `.env.example` | 否 | 当前 endpoint 已正确 |
| `src/core/**` | 否 | 本次升级不涉及业务链路重构 |
| `src/services/**` | 否 | 本次升级不涉及行情/交易上下文创建方式变更 |

## 6. 实施步骤

### 步骤 1：升级依赖

修改 `package.json` 中的 `longbridge` 版本到 `^4.0.3`，然后刷新 `bun.lock`。

目标：

1. 仓库声明基线变为 `4.0.3`
2. 本地真实安装版本同步变为 `4.0.3`

### 步骤 2：同步源码注释

修正 `src/config/auth/utils.ts` 中对 `4.0.0` 的硬编码描述，改为 `4.0.x`。

目标：

1. 避免源码注释滞后于依赖基线
2. 避免未来补丁版本升级再次修改同一句注释

### 步骤 3：同步 OAuth 文档

统一修正 `docs/others/longbridge-oauth-client-registration-and-authorization-guide.md` 中所有旧 token 缓存目录。

目标：

1. 首次授权说明与升级后真实行为一致
2. 验证步骤与排障步骤不再指向旧路径

### 步骤 4：同步仓库内部知识参考

相关 longbridge skill 文档已从仓库移除，本步骤不再适用。

目标：

1. 让仓库内的 SDK 参考基线与真实安装版本保持一致
2. 避免后续自动分析继续引用旧目录

### 步骤 5：执行升级验收

升级完成后，按仓库当前已有命令执行验收。

## 7. 验收方案

### 7.1 静态验收

执行：

```powershell
bun install
bun run type-check
```

通过标准：

1. `bun.lock` 已锁定到 `longbridge@4.0.3`
2. `type-check` 通过

### 7.2 配置层回归测试

执行：

```powershell
bun test tests/config/longbridgeOAuthConfig.business.test.ts
```

通过标准：

1. OAuth 配置解析与校验逻辑保持通过
2. `createSdkConfigFromAuth` 相关行为未因 SDK 升级产生回归

### 7.3 全量测试

执行：

```powershell
bun test
```

通过标准：

1. 仓库现有测试全部通过

### 7.4 运行时验收

在具备真实 `LONGBRIDGE_CLIENT_ID` 的环境下执行：

```powershell
bun start
```

通过标准：

1. 首次授权时程序能够正常输出 OAuth 授权 URL
2. 或已存在有效 token 时，程序能直接复用缓存并继续启动
3. `QuoteContext` 与 `TradeContext` 初始化成功
4. 不出现因域名或认证参数变化导致的启动失败

### 7.5 文档验收

通过标准：

1. 仓库内不再保留 `~/.longbridge-openapi/` 或 `%USERPROFILE%\.longbridge-openapi\` 作为 OAuth token 当前缓存路径说明
2. README 与 `.env.example` 仍保持当前正确 endpoint，不引入额外漂移

## 8. 关键决策

### 8.1 不在本次升级中接入 `4.0.2` 新内容 API

虽然 `4.0.2` 增加了 `news/topics/filings`，但当前交易系统并未使用这些能力。

本次若顺带引入这些接口，会产生以下问题：

1. 需求边界被扩散
2. 测试范围被扩大
3. 业务逻辑会发生额外变化

因此本次升级只同步 SDK 基线，不新增任何内容资讯能力。

### 8.2 不在应用层增加旧 token 目录兼容

`4.0.3` 已将 OAuth token 缓存目录迁移到新路径。

本次方案明确不做：

```text
先查新目录 -> 再查旧目录 -> 自动搬迁
```

原因：

1. 这属于兼容补丁，不符合本仓库方案规范
2. 会把当前正确基线重新拉回双路径状态
3. 会增加后续排障复杂度

最终原则是：

1. 应用代码只接受 `4.0.3` 官方当前行为
2. 若旧缓存无法复用，则通过重新授权生成新缓存，作为唯一正确基线

## 9. 实施后最终状态

实施完成后，仓库应满足以下条件：

1. 依赖与锁文件统一到 `longbridge@4.0.3`
2. `src/` 继续保持当前官方 `4.x` 认证工厂写法
3. 源码注释不再绑定过时的 `4.0.0`
4. OAuth 操作文档与内部知识参考统一指向新 token 缓存目录
5. 不新增任何业务层兼容分支
6. 不引入 `4.0.2` 新内容 API 的业务接入

## 10. 参考来源

1. npm registry: `https://registry.npmjs.org/longbridge`
2. 官方 Node.js 文档: `https://longbridge.github.io/openapi/nodejs/index.html`
3. 官方 changelog: `https://raw.githubusercontent.com/longbridge/openapi/b099c0f595504c43c383bca8fbb99c74bf619c3a/CHANGELOG.md`
4. `v4.0.1 -> v4.0.2` 对比: `https://github.com/longbridge/openapi/compare/v4.0.1...v4.0.2`
5. `4.0.3` 对应提交: `https://github.com/longbridge/openapi/commit/b099c0f595504c43c383bca8fbb99c74bf619c3a`

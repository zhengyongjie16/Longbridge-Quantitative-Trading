# Longbridge OAuth 客户端注册与首次授权操作指南

## 适用范围

本文面向当前仓库 `Longbridge-Quantitative-Trading`，说明如何按照 Longbridge 官方文档完成以下操作：

1. 开通 OpenAPI / 开发者权限
2. 注册 OAuth 客户端并获取 `client_id`
3. 将 `client_id` 写入当前项目配置
4. 首次启动项目并在浏览器中完成授权
5. 验证 token 已缓存且二次启动可复用
6. 排查常见失败原因

本文只覆盖当前仓库已经实现的 OAuth 认证路径：

- `LONGBRIDGE_CLIENT_ID`
- `LONGBRIDGE_CALLBACK_PORT`
- `OAuth.build(...)`
- `Config.fromOAuth(...)`

本文不使用旧的 `LONGPORT_APP_KEY / LONGPORT_APP_SECRET / LONGPORT_ACCESS_TOKEN` 方案，也不使用 `LONGBRIDGE_REGION`。

---

## 1. 前置条件

在注册 OAuth 客户端之前，先确认以下条件已满足：

1. 已有 Longbridge 账户
2. 已完成 Longbridge 开户
3. 已登录 Longbridge 官网
4. 已完成 OpenAPI / 开发者认证或对应权限申请

如果这些前提未完成，通常会出现以下问题：

- 官网页面没有可用的客户端注册入口
- 注册接口返回权限相关错误
- 后续浏览器授权无法完成

官方文档：

- OpenAPI 文档首页：<https://open.longbridge.com/zh-CN/docs>
- 快速开始：<https://open.longbridge.com/zh-CN/docs/getting-started>

---

## 2. 当前项目采用的 OAuth 方式

当前仓库已经迁移到 Longbridge Node SDK OAuth 模式，启动链路会读取：

```env
LONGBRIDGE_CLIENT_ID=...
LONGBRIDGE_CALLBACK_PORT=60355
```

然后在运行时执行：

```typescript
const oauth = await OAuth.build(clientId, onOpenUrl, callbackPort);
const config = Config.fromOAuth(oauth);
```

对应实现位置：

- [src/config/auth/index.ts](/D:/code/Longbridge-Quantitative-Trading/src/config/auth/index.ts)
- [src/config/auth/utils.ts](/D:/code/Longbridge-Quantitative-Trading/src/config/auth/utils.ts)
- [README.md](/D:/code/Longbridge-Quantitative-Trading/README.md)
- [.env.example](/D:/code/Longbridge-Quantitative-Trading/.env.example)

这意味着：

1. 你需要先拿到官方分配的 `client_id`
2. 首次运行时，SDK 会输出一个授权 URL
3. 你在浏览器中登录并同意授权
4. SDK 会把 token 持久化到本地缓存目录
5. 后续再次启动时，通常不需要重新授权

---

## 3. 注册前先确定回调地址

### 推荐值

对当前仓库，推荐直接使用：

```text
http://localhost:60355/callback
```

原因：

1. 当前项目默认回调端口就是 `60355`
2. `.env.example` 和 `README.md` 都已经按该端口说明
3. 可以减少注册参数与运行参数不一致的风险

### 必须满足的一致性要求

注册 OAuth 客户端时填入的 redirect URI，必须和运行时配置保持一致。

也就是：

- 注册时如果使用 `http://localhost:60355/callback`
- 那么项目里就应配置 `LONGBRIDGE_CALLBACK_PORT=60355`

如果你后续想改端口，例如改成 `60444`，那必须同时修改两处：

1. OAuth 客户端注册参数中的 redirect URI
2. 项目中的 `LONGBRIDGE_CALLBACK_PORT`

否则浏览器授权回调会失败。

---

## 4. 官方注册接口参数说明

根据 Longbridge 官方“快速开始”文档，OAuth 客户端注册接口为：

```text
POST https://openapi.longbridge.com/oauth2/register
```

推荐请求体结构：

```json
{
  "redirect_uris": ["http://localhost:60355/callback"],
  "token_endpoint_auth_method": "none",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "client_name": "Longbridge Quant Trading Local"
}
```

各字段含义：

- `redirect_uris`
  - OAuth 浏览器授权完成后的回调地址列表
  - 当前项目推荐使用 `http://localhost:60355/callback`
- `token_endpoint_auth_method`
  - 官方示例使用 `none`
  - 当前项目也按无 client secret 模式接入
- `grant_types`
  - 推荐为 `authorization_code` 和 `refresh_token`
- `response_types`
  - 推荐为 `code`
- `client_name`
  - 自定义名称，用于标识该客户端用途

---

## 5. 一行 PowerShell 注册命令（仅输出 `client_id`）

对当前项目来说，注册后真正需要落地到配置里的字段只有 `client_id`。因此可以把注册步骤收敛为一行命令，并且只打印 `client_id`：

```powershell
(Invoke-RestMethod -Method Post -Uri "https://openapi.longbridge.com/oauth2/register" -ContentType "application/json" -Body '{"redirect_uris":["http://localhost:60355/callback"],"token_endpoint_auth_method":"none","grant_types":["authorization_code","refresh_token"],"response_types":["code"],"client_name":"Longbridge Quant Trading Local"}').client_id
```

说明：

- 上面命令按当前项目默认端口 `60355` 注册回调地址
- 如果你改了回调端口，必须同步修改命令中的 `redirect_uris` 和 `.env.local` 的 `LONGBRIDGE_CALLBACK_PORT`

---

## 6. 自动写入 `.env.local` 的脚本

如果你希望注册成功后直接生成当前项目的 `.env.local`，使用下面这份脚本。

注意：该脚本会覆盖项目根目录现有的 `.env.local` 内容。如果你原来在 `.env.local` 里还有其他配置，请先备份或在执行后手工补回。

```powershell
$ErrorActionPreference = "Stop"

$clientName = "Longbridge Quant Trading Local"
$callbackPort = 60355
$redirectUri = "http://localhost:$callbackPort/callback"

$bodyObject = @{
  redirect_uris = @($redirectUri)
  token_endpoint_auth_method = "none"
  grant_types = @("authorization_code", "refresh_token")
  response_types = @("code")
  client_name = $clientName
}

$bodyJson = $bodyObject | ConvertTo-Json -Depth 5

$response = Invoke-RestMethod `
  -Method Post `
  -Uri "https://openapi.longbridge.com/oauth2/register" `
  -ContentType "application/json" `
  -Body $bodyJson

$envContent = @"
LONGBRIDGE_CLIENT_ID=$($response.client_id)
LONGBRIDGE_CALLBACK_PORT=$callbackPort
"@

Set-Content -Path ".env.local" -Value $envContent -Encoding utf8

Write-Host "OAuth client registered successfully."
Write-Host "Written to .env.local"
Write-Host ""
Write-Host $envContent
```

---

## 7. 注册成功后你应该保留哪些字段

注册接口返回内容里，至少会包含以下关键字段：

- `client_id`
- `registration_client_uri`
- `registration_access_token`

对当前项目来说，真正必须写入环境变量的是：

- `client_id`

当前项目需要的配置示例：

```env
LONGBRIDGE_CLIENT_ID=你的_client_id
LONGBRIDGE_CALLBACK_PORT=60355
```

说明：

- `registration_client_uri`
  - 常用于后续管理该 OAuth 客户端的注册信息
  - 当前项目运行时不需要读取它
- `registration_access_token`
  - 常用于访问上面的注册管理接口
  - 当前项目运行时也不需要读取它

如果你只是为了让当前仓库完成 OAuth 登录并启动交易程序，保留 `client_id` 即可。

---

## 8. 将配置写入当前项目

在项目根目录创建或编辑 `.env.local`：

```env
LONGBRIDGE_CLIENT_ID=你的_client_id
LONGBRIDGE_CALLBACK_PORT=60355
```

如果你还需要覆盖官方 SDK 的额外配置，可以按当前项目实现继续增加这些可选项：

```env
LONGBRIDGE_HTTP_URL=
LONGBRIDGE_QUOTE_WS_URL=
LONGBRIDGE_TRADE_WS_URL=
LONGBRIDGE_LANGUAGE=en
LONGBRIDGE_ENABLE_OVERNIGHT=false
LONGBRIDGE_PUSH_CANDLESTICK_MODE=realtime
LONGBRIDGE_PRINT_QUOTE_PACKAGES=false
LONGBRIDGE_LOG_PATH=
```

但在正常情况下，初次接入时不建议先改这些项。先让默认官方环境跑通更稳。

---

## 9. 首次浏览器授权的完整步骤

完成 `.env.local` 配置后，在项目根目录执行：

```powershell
bun start
```

首次运行时，程序会调用当前仓库的 OAuth 初始化逻辑：

1. 读取 `LONGBRIDGE_CLIENT_ID`
2. 读取 `LONGBRIDGE_CALLBACK_PORT`
3. 调用 `OAuth.build(...)`
4. 如果本地还没有可用 token，SDK 会生成授权 URL
5. 程序把该 URL 输出到终端日志
6. 你在浏览器中打开这个 URL
7. 登录 Longbridge 账户并确认授权
8. 浏览器回调到本地 `http://localhost:60355/callback`
9. SDK 交换并保存 token
10. 程序继续创建 `Config`、`QuoteContext`、`TradeContext`

如果流程正常，首次授权后再次启动，通常不会再次要求你手工打开授权页面。

---

## 10. token 缓存位置

根据 Longbridge 官方文档，OAuth token 会被持久化到本地目录。

当前系统为 Windows，默认路径是：

```text
%USERPROFILE%\.longbridge-openapi\tokens\<client_id>
```

例如：

```text
C:\Users\你的用户名\.longbridge-openapi\tokens\你的client_id
```

这一步的意义是：

1. 首次授权成功后，token 会落盘缓存
2. 后续程序再次启动时，SDK 会优先复用缓存 token
3. token 过期后，SDK 会按官方 OAuth 机制自动刷新

官方文档同时说明了 token 自动持久化和自动刷新。

---

## 11. 如何验证授权已经成功

建议按下面顺序验证。

### 验证 1：首次启动时能看到授权 URL

执行：

```powershell
bun start
```

如果本地尚无 token，你应该能在终端里看到类似“请访问此 URL 进行授权”的输出，或者至少看到一个明显的 OAuth 授权链接。

### 验证 2：浏览器能正常完成授权回调

在浏览器中打开该 URL 后，授权完成应能回调到：

```text
http://localhost:60355/callback
```

如果这里失败，通常说明：

- 端口不一致
- 端口被占用
- redirect URI 注册错误

### 验证 3：本地 token 缓存文件已生成

在 PowerShell 中执行：

```powershell
Get-ChildItem "$env:USERPROFILE\.longbridge-openapi\tokens" -Recurse
```

如果授权成功，应该能看到以你的 `client_id` 命名或对应的 token 缓存文件。

### 验证 4：第二次启动不再要求重新授权

再次执行：

```powershell
bun start
```

如果二次启动不再打印新的授权 URL，而是直接继续启动行情/交易上下文，说明缓存复用正常。

---

## 12. 常见失败原因与排查顺序

### 1. `redirect_uri` 不一致

这是最常见的问题。

例如：

- 注册时使用 `http://localhost:60355/callback`
- 运行时却配置了 `LONGBRIDGE_CALLBACK_PORT=60444`

这样浏览器授权回调一定失败。

排查方式：

1. 检查第 5 节命令里的 `redirect_uris` 是否是你实际要用的回调端口
2. 检查 `.env.local` 里的 `LONGBRIDGE_CALLBACK_PORT`
3. 确认两者完全一致

### 2. 本地回调端口被占用

如果 `60355` 已被其他程序占用，SDK 本地监听会失败。

排查命令：

```powershell
Get-NetTCPConnection -LocalPort 60355 -ErrorAction SilentlyContinue
```

如果已有其他进程占用，先释放端口，或者换一个端口重新注册 OAuth 客户端。

### 3. 还没有 OpenAPI / 开发者权限

如果你没有完成官方前置权限申请，注册接口或浏览器授权都可能失败。

排查方式：

1. 重新确认 Longbridge 账户是否已开户
2. 重新确认官网是否已完成 OpenAPI / 开发者认证
3. 必要时回到官方 OpenAPI 页面核对权限状态

### 4. `.env.local` 没有被正确读取

当前项目如果缺少 `LONGBRIDGE_CLIENT_ID`，启动校验会直接报错。

排查方式：

1. 确认 `.env.local` 位于项目根目录
2. 确认变量名是 `LONGBRIDGE_CLIENT_ID`
3. 确认没有写成旧的 `LONGPORT_APP_KEY` 等历史字段

### 5. 在无交互环境里做首次授权

首次 OAuth 授权本质上需要浏览器登录和用户确认。如果你直接在纯远程、无浏览器的环境里做第一次授权，流程会明显更麻烦。

更稳的做法是：

1. 先在本地有浏览器的环境完成首次授权
2. 确认 token 已生成
3. 再考虑如何部署到其他环境

---

## 13. 推荐的最小执行路径

如果你只想用最短路径把当前项目跑起来，按下面做：

1. 完成 Longbridge 开户和 OpenAPI / 开发者权限申请
2. 执行本文第 5 节的一行 PowerShell 注册命令
3. 记录返回的 `client_id`
4. 在项目根目录写入：

```env
LONGBRIDGE_CLIENT_ID=你的_client_id
LONGBRIDGE_CALLBACK_PORT=60355
```

5. 执行：

```powershell
bun start
```

6. 在浏览器中打开终端打印的授权 URL
7. 完成登录与授权确认
8. 验证 `%USERPROFILE%\.longbridge-openapi\tokens\<client_id>` 已生成缓存
9. 再次执行 `bun start`，确认不再重复授权

---

## 14. 当前项目相关文件索引

如果你要对照代码确认当前仓库的 OAuth 行为，可以看这些文件：

- [src/config/auth/index.ts](/D:/code/Longbridge-Quantitative-Trading/src/config/auth/index.ts)
- [src/config/auth/utils.ts](/D:/code/Longbridge-Quantitative-Trading/src/config/auth/utils.ts)
- [src/config/config.validator.ts](/D:/code/Longbridge-Quantitative-Trading/src/config/config.validator.ts)
- [README.md](/D:/code/Longbridge-Quantitative-Trading/README.md)
- [.env.example](/D:/code/Longbridge-Quantitative-Trading/.env.example)

---

## 15. 官方参考链接

- Longbridge OpenAPI 文档首页：<https://open.longbridge.com/zh-CN/docs>
- Longbridge 快速开始：<https://open.longbridge.com/zh-CN/docs/getting-started>
- Longbridge 刷新 Token 文档：<https://open.longbridge.com/zh-CN/docs/refresh-token-api>

如果官方页面结构后续调整，优先以 OpenAPI 文档首页导航到“快速开始”和 OAuth 相关文档为准。

# Longbridge OpenAPI OAuth 交易资产接口权限异常问题说明

## 建议的 GitHub Issue 标题

OAuth token 可正常访问 Quote API，但所有 Trade 资产接口持续返回 `202201 get userinfo error` / `602001 user not found`

## 问题摘要

我们正在使用官方 Node.js SDK `longbridge@4.0.0`，并通过 OAuth 2.0 接入 Longbridge OpenAPI。

当前现象是：

- OAuth 登录成功
- Quote API 可正常使用
- `TradeContext.new(...)` 可正常创建
- 但所有交易资产相关的只读接口持续失败

典型报错如下：

- `accountBalance()` 返回 `code=202201: get userinfo error`
- `stockPositions()` 返回 `code=500: internal server error`
- 其他部分交易只读接口返回 `code=602001: user not found`

我们已经进一步确认，这个问题不是本地项目逻辑导致的，因为即使完全绕过项目代码，直接使用 OAuth Bearer token 调用官方 HTTP API，也会得到相同结果。

## 环境信息

- 操作系统：Windows
- 运行时：Bun
- 官方 SDK：`longbridge@4.0.0`
- 认证方式：OAuth 2.0
- 复现日期：2026 年 3 月 13 日

## 已确认并排除的前提项

以下问题已经确认不是原因：

1. 开发者认证 / OpenAPI 权限申请已完成
2. 浏览器 OAuth 授权时登录的账号就是目标证券账号
3. 已删除本地 token 缓存并重新授权，不存在旧 token 复用问题
4. 该 Longbridge 账号本身有效，并且可在 Longbridge App 中正常交易
5. OAuth client 注册成功，redirect URI 与 callback port 一致

## OAuth 授权页观察到的现象

在浏览器授权页面中，只看到了行情/资讯等相关授权项，没有看到单独的“交易权限”授权选项。

根据公开文档理解，这似乎意味着：

- OAuth 页面负责账号授权
- 但交易能力并不是通过用户在 OAuth 页面手动勾选“交易权限”来开通
- 交易能力更像是由 OpenAPI 后台权限与证券账户绑定状态决定

相关官方文档：

- OpenAPI 文档首页：<https://open.longbridge.com/zh-CN/docs/>
- 快速开始：<https://open.longbridge.com/zh-CN/docs/getting-started>
- OAuth 2.0 接入流程：<https://open.longbridge.com/zh-CN/docs/how-to-access-api>
- 通用问题：<https://open.longbridge.com/zh-CN/docs/qa/general>

## 使用官方 Node SDK 的最小复现

最小复现代码如下：

```ts
import { OAuth, Config, QuoteContext, TradeContext } from 'longbridge';

const oauth = await OAuth.build(clientId, () => {}, 60355);
const config = Config.fromOAuth(oauth);

const quoteCtx = await QuoteContext.new(config);
const tradeCtx = await TradeContext.new(config);

await tradeCtx.accountBalance();
await tradeCtx.stockPositions();
```

实际结果：

- `OAuth.build(...)`：成功
- `Config.fromOAuth(...)`：成功
- `QuoteContext.new(...)`：成功
- `TradeContext.new(...)`：成功
- 行情权限包可以正常打印
- `accountBalance()`：失败，报错 `openapi error: code=202201: get userinfo error`
- `stockPositions()`：失败，报错 `openapi error: code=500: internal server error`

我们还测试过：

- `todayOrders()` / `historyOrders()` -> `code=602001: user not found`
- `fundPositions()` -> `code=202201: get userinfo error`
- trade websocket 私有主题订阅可以成功

因此问题集中在交易侧 REST 接口的用户/账户识别阶段。

## 直接调用官方 HTTP API 的复现结果

为了彻底排除 SDK 封装或本地项目逻辑的影响，我们直接使用 OAuth Bearer token 调用了官方 HTTP API。

### 1. Quote API 正常

请求：

```bash
curl -H "Authorization: Bearer <oauth_access_token>" \
  "https://openapi.longbridge.com/v1/quote/get_security_list?market=US&category=Overnight"
```

响应：

```json
{"code":0,"message":"success", ...}
```

### 2. 账户资产接口失败

请求：

```bash
curl -H "Authorization: Bearer <oauth_access_token>" \
  "https://openapi.longbridge.com/v1/asset/account"
```

响应：

```json
{ "code": 202201, "message": "获取用户信息失败", "data": null }
```

### 3. 股票持仓接口失败

请求：

```bash
curl -H "Authorization: Bearer <oauth_access_token>" \
  "https://openapi.longbridge.com/v1/asset/stock"
```

响应：

```json
{ "code": 500, "message": "internal server error", "data": null }
```

### 4. 其他交易只读接口同样失败

请求：

```bash
curl -H "Authorization: Bearer <oauth_access_token>" \
  "https://openapi.longbridge.com/v1/trade/execution/today"
```

响应：

```json
{ "code": 602001, "message": "user not found", "data": null }
```

由于官方原始 HTTP 接口也完全复现同样的问题，因此我们认为这已经可以排除为本地代码问题。

## 为什么我们怀疑是后台权限或账户绑定问题

根据公开文档和实际表现，我们目前的判断是：

1. OAuth client 注册只负责生成 `client_id`，注册请求体中并没有交易权限字段
2. OAuth 授权页也没有单独的“交易权限”勾选项
3. 同一个 OAuth token 可以正常访问 Quote API
4. 但 Trade 资产类 REST 接口持续返回与用户/账户识别相关的错误
5. 官方 HTTP API 直连也失败，说明问题不在本地 SDK 调用方式

因此我们怀疑：

- 当前 OAuth token 是有效的
- 但交易侧后台没有正确识别并绑定到可用证券账户
- 或者该账号的 OpenAPI 交易资产权限在后台尚未真正生效

## 相关官方文档

- 获取账户资金：<https://open.longbridge.com/zh-CN/docs/trade/asset/account>
- 获取股票持仓：<https://open.longbridge.com/zh-CN/docs/trade/asset/stock>
- OAuth 2.0 接入流程：<https://open.longbridge.com/zh-CN/docs/how-to-access-api>
- OpenAPI 首页：<https://open.longbridge.com/zh-CN/docs/>
- 通用问题：<https://open.longbridge.com/zh-CN/docs/qa/general>

## 希望官方确认的问题

1. 对于 OAuth 2.0 接入用户，除了以下步骤之外，是否还需要额外的后台开通流程，交易资产接口才能可用？
   - 开户
   - 开发者认证 / OpenAPI 权限申请
   - OAuth client 注册
   - 浏览器授权

2. 当 Quote API 正常，但 Trade 资产类接口返回以下错误时：
   - `202201 get userinfo error`
   - `602001 user not found`
   - `500 internal server error`

   这是否特指交易侧用户/证券账户绑定未完成或后台状态异常？

3. 是否有公开方式可以自查某个 OAuth token 是否已正确绑定到可用证券账户，从而可访问 Trade API？

4. OAuth 授权页中没有单独的“交易权限”选项，这是否是预期行为？

5. 对于我们当前这组现象，官方是否可以确认这是服务端权限/账户映射问题，而不是 SDK 使用方式问题？

## 额外说明

- 本文未包含 `client_id`、access token 或个人账户标识等敏感信息
- 如有需要，我们可以私下提供精确复现时间和脱敏日志

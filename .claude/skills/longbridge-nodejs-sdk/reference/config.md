# Config - SDK 配置

## OAuth 2.0（推荐）

### 必需环境变量

| 环境变量                   | 说明                                         | 默认值  |
| -------------------------- | -------------------------------------------- | ------- |
| `LONGBRIDGE_CLIENT_ID`     | OAuth Client ID                              | 必填    |
| `LONGBRIDGE_CALLBACK_PORT` | 本地回调端口，需与 OAuth Client 注册回调一致 | `60355` |

### 可选环境变量

| 环境变量 | 说明 | 默认值 |
| --- | --- | --- |
| `LONGBRIDGE_HTTP_URL` | HTTP API URL | `https://openapi.longbridge.com` |
| `LONGBRIDGE_QUOTE_WS_URL` | 行情 WebSocket URL | `wss://openapi-quote.longbridge.com/v2` |
| `LONGBRIDGE_TRADE_WS_URL` | 交易 WebSocket URL | `wss://openapi-trade.longbridge.com/v2` |
| `LONGBRIDGE_LANGUAGE` | 语言 `zh-CN` / `zh-HK` / `en` | `en` |
| `LONGBRIDGE_ENABLE_OVERNIGHT` | 启用夜盘行情 | `false` |
| `LONGBRIDGE_PUSH_CANDLESTICK_MODE` | K 线推送模式 `realtime` / `confirmed` | `realtime` |
| `LONGBRIDGE_PRINT_QUOTE_PACKAGES` | 连接时打印行情套餐 | `true` |
| `LONGBRIDGE_LOG_PATH` | SDK 日志目录 | `无` |

## Config 类

```typescript
import { OAuth, Config } from 'longbridge';

const oauth = await OAuth.build('your-client-id', (_, url) => {
  console.log('Visit:', url);
});
const config = Config.fromOAuth(oauth);
```

OAuth token 的持久化、刷新与复用由 SDK 内部负责。

## ExtraConfigParams 接口

```typescript
interface ExtraConfigParams {
  httpUrl?: string;
  quoteWsUrl?: string;
  tradeWsUrl?: string;
  language?: Language;
  enableOvernight?: boolean;
  pushCandlestickMode?: PushCandlestickMode;
  enablePrintQuotePackages?: boolean;
  logPath?: string;
}
```

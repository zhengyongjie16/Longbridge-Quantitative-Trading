# Config - SDK 配置

## 环境变量

| 环境变量 | 说明 | 默认值 |
|---------|------|--------|
| `LONGPORT_APP_KEY` | App Key | 必填 |
| `LONGPORT_APP_SECRET` | App Secret | 必填 |
| `LONGPORT_ACCESS_TOKEN` | Access Token | 必填 |
| `LONGPORT_HTTP_URL` | HTTP API URL | `https://openapi.longportapp.com` |
| `LONGPORT_QUOTE_WS_URL` | 行情 WebSocket URL | `wss://openapi-quote.longportapp.com/v2` |
| `LONGPORT_TRADE_WS_URL` | 交易 WebSocket URL | `wss://openapi-trade.longportapp.com/v2` |
| `LONGPORT_LANGUAGE` | 语言 `zh-CN`/`zh-HK`/`en` | `en` |
| `LONGPORT_ENABLE_OVERNIGHT` | 启用夜盘行情 | `false` |
| `LONGPORT_PUSH_CANDLESTICK_MODE` | K线推送模式 `realtime`/`confirmed` | `realtime` |
| `LONGPORT_PRINT_QUOTE_PACKAGES` | 连接时打印行情套餐 | `true` |

## Config 类

```typescript
// 从环境变量/.env 文件创建（推荐）
const config = Config.fromEnv();

// 手动创建（参数详见 ConfigParams 接口）
const config = new Config({
  appKey: "your_app_key",
  appSecret: "your_app_secret",
  accessToken: "your_access_token",
  language: Language.ZH_CN,
});

// 刷新 Access Token（expiredAt 默认 90 天后过期）
const newToken: string = await config.refreshAccessToken(expiredAt?: Date);
```

## ConfigParams 接口

```typescript
interface ConfigParams {
  appKey: string;              // App Key（必填）
  appSecret: string;           // App Secret（必填）
  accessToken: string;         // Access Token（必填）
  httpUrl?: string;            // HTTP API URL（默认 https://openapi.longportapp.com）
  quoteWsUrl?: string;         // 行情 WS URL（默认 wss://openapi-quote.longportapp.com/v2）
  tradeWsUrl?: string;         // 交易 WS URL（默认 wss://openapi-trade.longportapp.com/v2）
  language?: Language;          // 语言（默认 Language.EN）
  enableOvernight?: boolean;    // 启用夜盘（默认 false）
  pushCandlestickMode?: PushCandlestickMode; // K线推送模式（默认 Realtime）
  enablePrintQuotePackages?: boolean; // 打印行情套餐（默认 true）
  logPath?: string;             // 日志路径（默认无日志）
}
```

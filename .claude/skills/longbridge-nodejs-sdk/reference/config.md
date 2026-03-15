# Authentication & Config

## Authentication

Longbridge OpenAPI supports two authentication methods:

1. OAuth 2.0 (recommended)
2. Legacy API Key (environment variables)

## OAuth 2.0

OAuth 2.0 is the recommended method and uses Bearer tokens.

### OAuth

```ts
class OAuth {
  static build(
    clientId: string,
    onOpenUrl: (err: Error, arg: string) => void,
    callbackPort?: number,
  ): Promise<OAuth>;
}
```

- `clientId`: OAuth client ID from Longbridge developer portal.
- `onOpenUrl`: callback that receives the authorization URL.
- `callbackPort` default: `60355`.

## Legacy API Key

Reference environment variables for API Key authentication:

- `LONGBRIDGE_APP_KEY`
- `LONGBRIDGE_APP_SECRET`
- `LONGBRIDGE_ACCESS_TOKEN`

You can create config from these variables via `Config.fromApikeyEnv()`.

## Environment Variables

### Authentication variables

- `LONGBRIDGE_APP_KEY`
- `LONGBRIDGE_APP_SECRET`
- `LONGBRIDGE_ACCESS_TOKEN`

### Other environment variables

| Variable | Meaning | Default / Reference values |
| --- | --- | --- |
| `LONGBRIDGE_LANGUAGE` | SDK language | default `en`; values `zh-CN`, `zh-HK`, `en` |
| `LONGBRIDGE_HTTP_URL` | HTTP endpoint URL | default `https://openapi.longbridge.com` |
| `LONGBRIDGE_QUOTE_WS_URL` | Quote WebSocket endpoint URL | default `wss://openapi-quote.longbridge.com/v2` |
| `LONGBRIDGE_TRADE_WS_URL` | Trade WebSocket endpoint URL | default `wss://openapi-trade.longbridge.com/v2` |
| `LONGBRIDGE_ENABLE_OVERNIGHT` | Enable overnight | default `false`; values `true` / `false` |
| `LONGBRIDGE_PUSH_CANDLESTICK_MODE` | Candlestick push mode | default `realtime`; values `realtime` / `confirmed` |
| `LONGBRIDGE_PRINT_QUOTE_PACKAGES` | Print quote packages after server connection | default `true`; values `true` / `false` |
| `LONGBRIDGE_LOG_PATH` | SDK log directory | default `no logs` |

`Config.fromApikeyEnv()` first reads the `.env` file in the current directory.

## Config

### `Config.fromOAuth(...)`

```ts
Config.fromOAuth(oauth: OAuth, extra?: ExtraConfigParams): Config
```

Reference behavior:

- Builds `Config` from an OAuth handle.
- Reads optional env vars automatically (`LONGBRIDGE_HTTP_URL`, `LONGBRIDGE_LANGUAGE`, `LONGBRIDGE_QUOTE_WS_URL`, `LONGBRIDGE_TRADE_WS_URL`, `LONGBRIDGE_ENABLE_OVERNIGHT`, `LONGBRIDGE_PUSH_CANDLESTICK_MODE`, `LONGBRIDGE_PRINT_QUOTE_PACKAGES`, `LONGBRIDGE_LOG_PATH`).
- If the same field is present in `extra`, `extra` overrides the environment variable.

### `Config.fromApikey(...)`

```ts
Config.fromApikey(
  appKey: string,
  appSecret: string,
  accessToken: string,
  extra?: ExtraConfigParams,
): Config
```

Reference behavior:

- Builds `Config` from API key credentials.
- Reads the same optional env vars automatically.
- If the same field is present in `extra`, `extra` overrides the environment variable.

### `Config.fromApikeyEnv()`

```ts
Config.fromApikeyEnv(): Config
```

Reference behavior:

- Builds `Config` from environment variables in API key mode.
- Reads `.env` in current directory first.

## ExtraConfigParams

```ts
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

Reference defaults for these fields (when not overridden):

- `httpUrl`: `https://openapi.longbridge.com`
- `quoteWsUrl`: `wss://openapi-quote.longbridge.com/v2`
- `tradeWsUrl`: `wss://openapi-trade.longbridge.com/v2`
- `language`: `Language.EN`
- `enableOvernight`: `false`
- `pushCandlestickMode`: `PushCandlestickMode.Realtime`
- `enablePrintQuotePackages`: `true`
- `logPath`: no logs

## Token Cache

Reference OAuth token cache behavior:

- Cache path: `~/.longbridge-openapi/tokens/<client_id>`
- `OAuth.build(...)` loads cached token if it exists and is still valid.
- If no valid cache exists, it starts browser authorization flow automatically.
- After successful authorization or refresh, token is persisted to the same path.

## Examples

### OAuth 2.0

```ts
import { OAuth, Config } from 'longbridge';

const oauth = await OAuth.build('your-client-id', (_, url) => {
  console.log('Visit this URL:', url);
});

const config = Config.fromOAuth(oauth);
```

### Legacy API Key

```ts
import { Config } from 'longbridge';

const config = Config.fromApikeyEnv();
```

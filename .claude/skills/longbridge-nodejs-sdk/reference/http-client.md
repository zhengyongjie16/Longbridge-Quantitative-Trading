# HttpClient

Official source:

- https://longbridge.github.io/openapi/nodejs/classes/HttpClient.html

## Position in SDK

`HttpClient` is the low-level HTTP request client in the Node.js SDK. The official page is concise and mainly documents constructor/factory methods and a generic `request(...)` method.

## Class API

```ts
class HttpClient {
  static fromApikey(
    appKey: string,
    appSecret: string,
    accessToken: string,
    httpUrl?: string,
  ): HttpClient;

  static fromApikeyEnv(): HttpClient;

  static fromOAuth(oauth: OAuth, httpUrl?: string): HttpClient;

  request(
    method: string,
    path: string,
    headers?: Record<string, string>,
    body?: any,
  ): Promise<any>;
}
```

## Factory methods

### `HttpClient.fromApikey(...)`

Creates `HttpClient` with API Key authentication.

Official notes:

- Reads `LONGBRIDGE_HTTP_URL` automatically.
- Official default when `httpUrl` is omitted: `https://openapi.longbridge.com`.

### `HttpClient.fromApikeyEnv()`

Creates `HttpClient` from environment variables (API Key mode).

Official notes:

- First reads `.env` in the current directory.
- Uses:
  - `LONGBRIDGE_HTTP_URL`
  - `LONGBRIDGE_APP_KEY`
  - `LONGBRIDGE_APP_SECRET`
  - `LONGBRIDGE_ACCESS_TOKEN`

### `HttpClient.fromOAuth(...)`

Creates `HttpClient` from an `OAuth` handle.

Official notes:

- Reads `LONGBRIDGE_HTTP_URL` automatically.
- Official default when `httpUrl` is omitted: `https://openapi.longbridge.com`.

## `request(...)`

```ts
request(
  method: string,
  path: string,
  headers?: Record<string, string>,
  body?: any,
): Promise<any>
```

Official description: performs an HTTP request.

## Usage notes

- The official `HttpClient` page is a thin reference page.
- For end-to-end trading/quote workflows, the official docs primarily guide users toward `Config` + `QuoteContext` / `TradeContext`.
- See also:
  - [Config / OAuth / ExtraConfigParams](./config.md)
  - [QuoteContext](./quote-context.md)
  - [TradeContext](./trade-context.md)

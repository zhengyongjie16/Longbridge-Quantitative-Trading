---
slug: watchlist_update_group
title: Update Watchlist Group
language_tabs: false
toc_footers: []
includes: []
search: true
highlight_theme: ''
headingLevel: 2
---

Update watched group


## SDK

| Language | Link |
|---|---|
| Python | [longport.openapi.quote._quote_context](https://longportapp.github.io/openapi/python/reference_all/#longport.openapi.quote._quote_context) |
| Rust | [longport::<SDKLinks module="quote" klass="QuoteContext" method="update_watchlist_group" />::quote#_quote_context](https://longportapp.github.io/openapi/rust/longport/<SDKLinks module="quote" klass="QuoteContext" method="update_watchlist_group" />/struct.quote.html#method._quote_context) |
| Go | [quote.update_watchlist_group](https://pkg.go.dev/github.com/longportapp/openapi-go/<SDKLinks module="quote" klass="QuoteContext" method="update_watchlist_group" />#quote.update_watchlist_group) |
| Node.js | [quote#QuoteContext](https://longportapp.github.io/openapi/nodejs/classes/quote.html#quotecontext) |

## Request

<table className="http-basic">
<tbody>
<tr><td className="http-basic-key">HTTP Method</td><td>PUT</td></tr>
<tr><td className="http-basic-key">HTTP URL</td><td>/v1/watchlist/groups</td></tr>
</tbody>
</table>

### Parameters

> Content-Type: application/json; charset=utf-8

| Name       | Type     | Required | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id         | integer  | YES      | Group ID, for example `10086`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| name       | string   | NO       | Group name, for example `Information Technology Group`. <br /> If this parameter is not passed, the group name will not be updated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| securities | string[] | NO       | Security list, for example `["BABA.US", "AAPL.US"]`.<br /> Combined with the `mode` parameter below, it can be used to add securities, remove securities, and sort the watchlist.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| mode       | string   | NO       | Operation method<br /> **optional values:**<br /> `add` - Add securities<br /> `remove` - Remove securities<br /> `replace` - Update securities<br /><br /> When selecting `add`, the securities in the above list will be added to this group in order.<br /><br /> When selecting `remove`, the securities in the above list will be removed from this group.<br /><br /> When selecting `update`, the securities in the above list will completely replace the securities in this group.<br /> For example, if the original group contains `APPL.US, BABA.US, TSLA.US`, and it is updated with `["BABA.US", "AAPL.US", "MSFT.US"]`, it will become `BABA.US, AAPL.US, MSFT.US`, removing `TSLA.US` and adding `MSFT.US`, while adjusting the order of `BABA.US and AAPL.US`. |

### Request Example

```python
from longport.openapi import QuoteContext, Config, SecuritiesUpdateMode

config = Config.from_env()
ctx = QuoteContext(config)
ctx.update_watchlist_group(10086, name = "Watchlist2", securities = ["700.HK", "AAPL.US"], SecuritiesUpdateMode.Replace)
```

## Response

### Response Headers

- Content-Type: application/json

### Response Example

```json
{
  "code": 0
}
```

### Response Status

| Status | Description    | Schema |
| ------ | -------------- | ------ |
| 200    | Success        | None   |
| 500    | Internal error | None   |

<aside className="success">
</aside>

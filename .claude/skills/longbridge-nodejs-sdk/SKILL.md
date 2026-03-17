---
name: longbridge-nodejs-sdk
description: Use when working with the Longbridge OpenAPI Node.js/TypeScript `longbridge` SDK or questions about `Config`, `OAuth`, `QuoteContext`, `TradeContext`, `HttpClient`, `Decimal`, enums, quote/trade types, subscriptions, candlesticks, order submission, account assets, or when the user asks to compare SDK behavior with the official documentation.
---

# Longbridge OpenAPI SDK for Node.js

## Overview

This skill is a local-first reference for the `longbridge` NPM package. Read local `reference/*.md` first for speed and consistency. Only cross-check the official docs when the user explicitly asks for official/latest confirmation.

## When to Use

Use this skill when the user:

- asks how to use a specific SDK API, class, enum, or type
- asks for method signatures, required vs optional fields, return types, or a minimal example
- asks about authentication setup, `Config.fromOAuth`, `Config.fromApikey*`, environment variables, or token cache behavior
- asks about market data, subscriptions, candlesticks, options, warrants, order submission, executions, balances, positions, or account assets
- wants official Longbridge SDK docs compared against the local reference

Do not use this skill for repository business rules unless the question is specifically about the `longbridge` SDK API.

## Lookup Map

| Question                                                   | Read first                       |
| ---------------------------------------------------------- | -------------------------------- |
| OAuth, API key, env vars, `Config`, token cache            | `reference/config.md`            |
| `HttpClient` low-level calls                               | `reference/http-client.md`       |
| Quote APIs, subscriptions, candlesticks, options, warrants | `reference/quote-context.md`     |
| Orders, executions, balances, positions                    | `reference/trade-context.md`     |
| `Decimal`, `NaiveDate`, `NaiveDatetime`, `Time`            | `reference/decimal.md`           |
| Enum meanings                                              | `reference/enums.md`             |
| Quote data structures                                      | `reference/types/quote-types.md` |
| Trade data structures and option interfaces                | `reference/types/trade-types.md` |

## Working Rules

- Prefer local references before reading external docs.
- Lead with the relevant API or type signature.
- Separate required fields from optional fields when describing parameters.
- Include only the smallest runnable TypeScript example that answers the user’s question.
- Mention operational caveats when they matter, such as long-running push subscriptions, OAuth browser flow, `.env` loading, or environment variable precedence.
- If local references do not fully settle a detail, state what is confirmed locally and mark the rest as needing official or source verification.

## Official Cross-Check

Only if the user explicitly asks for official/latest confirmation, use the canonical official entry:

`https://longbridge.github.io/openapi/nodejs/index.html`

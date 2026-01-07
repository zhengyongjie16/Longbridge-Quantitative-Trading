# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**LongBridge Quantitative Trading System** - Automated Hong Kong stock trading system for warrant (牛熊证) trading based on Hang Seng Index technical indicators.

- **Tech Stack**: Node.js, TypeScript, LongPort OpenAPI SDK
- **Trading Strategy**: Monitors HSI technical indicators (RSI, KDJ, MACD, MFI, EMA) → Generates signals with 60-90s delayed verification → Executes bull/bear warrant trades with intelligent position management
- **Architecture**: Event-driven 1-second loop, modular core services with factory pattern, object pool optimization

## Configuration Setup

1. Copy `.env.example` to `.env.local`
2. Fill in **required** fields:
   - `LONGPORT_APP_KEY`, `LONGPORT_APP_SECRET`, `LONGPORT_ACCESS_TOKEN`
   - `MONITOR_SYMBOL` (e.g., HSI.HK - generates signals)
   - `LONG_SYMBOL`, `SHORT_SYMBOL` (warrant symbols for trading)
   - Signal configurations: `SIGNAL_BUYCALL`, `SIGNAL_SELLCALL`, `SIGNAL_BUYPUT`, `SIGNAL_SELLPUT`
   - Trading parameters: `TARGET_NOTIONAL`, `LONG_LOT_SIZE`, `SHORT_LOT_SIZE`
   - Risk limits: `MAX_POSITION_NOTIONAL`, `MAX_DAILY_LOSS`, `MAX_UNREALIZED_LOSS_PER_SYMBOL`

**Configuration is validated on startup** - program will not run if validation fails.

## Code Architecture

### Execution Flow (1-second loop in `src/index.ts`)

```
runOnce() executes every 1 second:
├─ Check trading session & trading day
├─ Fetch candlestick data (1m period, 200 bars)
├─ Calculate indicators (RSI/MFI/KDJ/MACD/EMA)
├─ Strategy generates signals (buy/sell)
├─ Record indicator history for pending signals
├─ Verify pending signals (T0+60-90s with T0/T0+5s/T0+10s trend validation)
├─ Apply risk checks (6 checks in fixed order)
├─ Process sell signals (cost-based quantity calculation)
├─ Execute orders (ELO limit orders / MO market orders)
├─ Monitor unfilled buy orders (auto price adjustment)
└─ Update order records & monitor unrealized loss
```

### Module Structure

**Core Modules** (`src/core/`):
- `strategy/` - Signal generation based on technical indicators
- `signalVerification/` - Delayed signal verification with trend validation
- `signalProcessor/` - Risk checking and sell signal processing
- `trader/` - Order execution (facade for sub-modules: rateLimiter, accountService, orderCacheManager, orderMonitor, orderExecutor)
- `orderRecorder/` - Order tracking & filtering (for intelligent position closing)
- `risk/` - Risk checkers (position limits, warrant risk, unrealized loss)
- `marketMonitor/` - Real-time price & indicator monitoring
- `doomsdayProtection/` - End-of-day protection (15min no-buy, 5min force-close)
- `unrealizedLossMonitor/` - Real-time loss monitoring & emergency liquidation

**Services** (`src/services/`):
- `indicators/` - Technical indicator calculations using `technicalindicators` library
- `quoteClient/` - Market data fetching from LongPort API

**Utilities** (`src/utils/`):
- `objectPool.ts` - Memory optimization (Signal/Position/KDJ/MACD object reuse)
- `signalConfigParser.ts` - Parse signal configuration DSL
- `indicatorHelpers.ts` - Indicator value extraction and validation
- `tradingTime.ts` - HK trading session calculations
- `accountDisplay.ts` - Account & position display formatting
- `logger.ts` - Pino-based logging system
- `helpers.ts` - Symbol normalization, action checking, error formatting

**Configuration** (`src/config/`):
- `config.index.ts` - LongPort API configuration
- `config.trading.ts` - Trading parameters (loaded from env)
- `config.validator.ts` - Startup validation (API connectivity, symbol validity)

### Critical Design Patterns

**1. Factory Pattern**: All modules use factory functions (e.g., `createTrader()`, `createRiskChecker()`), **never classes**

**2. Dependency Injection**: Dependencies passed as parameters, never created internally
```typescript
// Good
export const createTrader = async (deps: TraderDeps = {}): Promise<Trader> => {
  const config = deps.config ?? createConfig();
  // ...
}

// Bad - DON'T create dependencies internally
export const createTrader = async (): Promise<Trader> => {
  const config = createConfig(); // ❌
  // ...
}
```

**3. Object Pools**: Reuse Signal/Position/KDJ/MACD objects to reduce GC pressure
```typescript
// Acquire from pool
const signal = signalObjectPool.acquire();
// Use it...
// Release back to pool
signalObjectPool.release(signal);
```

**4. Type Organization**:
- Each module has `type.ts` for module-specific types
- Shared types in `src/types/index.ts`
- Use `readonly` for immutability where performance allows

### Risk Check Execution Order (FIXED)

From `src/core/signalProcessor/index.ts` - **6 checks in this exact order**:
1. Buy interval limit (60s between same-direction buys)
2. Buy price validation (reject if ask > last trade price)
3. Doomsday protection (no buy 15min before close)
4. Warrant risk check (bull/bear distance from strike price)
5. Daily loss limit (`MAX_DAILY_LOSS`)
6. Position limit (`MAX_POSITION_NOTIONAL`)

### Order Filtering Algorithm (OrderRecorder)

**Critical**: Process orders **chronologically from oldest to newest** (never reverse)

Algorithm flow:
1. M0 = Buy orders after latest sell timestamp
2. Filter historical high-price buys not fully sold
3. Final records = M0 + filtered buys

This enables **intelligent position closing**:
- If `currentPrice > costPrice`: Sell all positions
- If `currentPrice ≤ costPrice`: Only sell orders where `buyPrice < currentPrice`

## Built-in Skills

This project has 3 Claude Code skills in `.claude/skills/`:

1. **`/business-logic`**: Business logic knowledge base
   - Signal generation, buy/sell strategies, order filtering
   - Risk checks, unrealized loss monitoring, warrant risk
   - Cost-based selling, delayed verification
   - **Use when**: Understanding trading logic, verifying code against business rules, debugging issues

2. **`/longbridge-openapi-documentation`**: LongPort API docs
   - **Use when**: Working with LongPort SDK API calls, checking API parameters/responses

3. **`/typescript-project-specifications`**: Strict TypeScript coding standards
   - Factory pattern, dependency injection, immutability, type organization
   - **MUST use** when writing/modifying ANY TypeScript code
   - Enforces project conventions (no classes, readonly types, camelCase files)

**Important**: When user mentions skill names or modifying code, invoke the appropriate skill.

## TypeScript Requirements

This project uses **STRICT TypeScript** (`tsconfig.json` has all strict flags enabled):
- `strict: true` + all individual strict flags
- `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`
- `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
- **ES2022 target**, **ESNext modules** with `.js` imports (not `.ts`)

**Before ANY commit**:
1. Run `npm run type-check` - must pass with 0 errors
2. Run `npm run lint` - must pass (or use `npm run lint:fix`)

## Signal Configuration DSL

Format: `(condition1,condition2,...)/N|(conditionA)|(conditionB,conditionC)/M`

- Parentheses group conditions (comma-separated)
- `/N`: Require N conditions in group to be satisfied
- `|`: OR operator between groups (max 3 groups)
- Supported indicators: `RSI:n`, `MFI`, `K`, `D`, `J`, `MACD`, `DIF`, `DEA`, `EMA:n`
- Operators: `<`, `>`
- Supports negative thresholds (e.g., `J<-20`)

Example: `(RSI:6<20,MFI<15,D<20,J<-1)/3|(J<-20)`
→ Group1 needs 3/4 conditions OR Group2 needs J<-20

## Delayed Signal Verification

**All signals** (buy AND sell) undergo delayed verification:
- Buy signals: `VERIFICATION_DELAY_SECONDS_BUY` (default 90s)
- Sell signals: `VERIFICATION_DELAY_SECONDS_SELL` (default 75s)

Verification mechanism:
- Record indicator values at T0 (signal trigger)
- Check again at T0+5s, T0+10s, and T0+delay
- **BUYCALL/SELLPUT**: Indicators must show **uptrend** (T0+5s/T0+10s > T0)
- **BUYPUT/SELLCALL**: Indicators must show **downtrend** (T0+5s/T0+10s < T0)

Configured via `VERIFICATION_INDICATORS_BUY` / `VERIFICATION_INDICATORS_SELL` (default: `D,DIF`)

## Doomsday Protection

When `DOOMSDAY_PROTECTION=true`:
- **15 minutes before close** (15:45-16:00): Reject all buy orders
- **5 minutes before close** (15:55-16:00): Force liquidate all positions (market orders)
- Supports half-day trading (12:00 close → protection at 11:45 and 11:55)

## Key Trading Concepts

**Monitor Symbol vs Trading Symbols**:
- Monitor symbol (e.g., HSI.HK): Generates signals via indicators
- Trading symbols (LONG_SYMBOL, SHORT_SYMBOL): Warrants executed on

**Signal Types**:
- BUYCALL: Buy bull warrant (bullish on HSI)
- SELLCALL: Sell bull warrant (close long position)
- BUYPUT: Buy bear warrant (bearish on HSI)
- SELLPUT: Sell bear warrant (close short position)

**Cost Price vs Opening Cost**:
- **平摊成本价 (Average Cost)**: For profit determination (sell decision)
- **开仓成本 (Opening Cost)**: For unrealized loss calculation (R1/N1 algorithm)

**Order Types**:
- **ELO (Enhanced Limit Order)**: Normal trading
- **MO (Market Order)**: Emergency liquidation (doomsday/unrealized loss triggers)

## Common Pitfalls

1. **Never modify object pool objects after release** - they're reused
2. **Order filtering MUST be chronological** - oldest to newest
3. **Risk checks have fixed order** - don't reorder them
4. **Import paths use `.js` extension** not `.ts` (ESNext modules)
5. **All dependencies injected** - no internal creation
6. **Types use `readonly`** where performance allows
7. **File naming is camelCase** not PascalCase or kebab-case

## Logging

- Console: Real-time status (Pino with pino-pretty)
- Files: `logs/system/` (always) and `logs/debug/` (if `DEBUG=true`)
- Trade records: `logs/trades/YYYY-MM-DD.json`

Debug mode: Set `DEBUG=true` in `.env.local` for verbose logging

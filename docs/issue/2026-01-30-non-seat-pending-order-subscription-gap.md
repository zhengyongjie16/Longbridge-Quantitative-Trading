# Issue: Non-seat pending order symbols not subscribed

## Summary
`collectAllQuoteSymbols()` only returns monitor symbols and seat symbols. The
subscription update logic uses this set, so symbols that are not in seats are
never added. The "avoid unsubscribe" logic only prevents removing already
subscribed symbols; it does not add missing symbols.

## Why this matters
If there are pending orders for a symbol that is not currently in any seat
(for example, after restart or after a seat is cleared), the symbol may not be
subscribed. Then `getQuotes()` cannot return fresh prices, and order price
tracking lacks quotes and cannot update prices.

## Repro scenario
- Restart with pending orders for an old symbol.
- Seat is empty or switched; old symbol is not in any seat.
- `collectAllQuoteSymbols()` excludes the old symbol.
- `subscribeSymbols(added)` never includes it because it is not in the desired
  subscription set.

## Expected behavior
Symbols with pending orders should be included in the subscription set (or
explicitly subscribed) until orders are completed.

## Current behavior
Only seat symbols are included; non-seat pending-order symbols are never added.

## Affected code
- `src/utils/helpers/quoteHelpers.ts`
- `src/main/mainProgram/index.ts`
- `src/core/trader/orderMonitor.ts`

## Notes
Documentation-only record; no code changes requested.

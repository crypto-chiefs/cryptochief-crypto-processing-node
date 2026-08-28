# Changelog

## [0.4.0] — 2026-08-28

Same API surface as the Go SDK v0.4.0; the version numbers across the SDK family
line up again.

- Auto-sweep settings: `client.sweeps.settings()` and `client.sweeps.updateSettings()` — read and write the policy that decides when a deposit wallet is swept (on arrival, above a USD threshold, or never). The read returns three layers — effective, override and project default — because only the three together say whether a value is the wallet's own or inherited, and inheritance is per field
- `updateSettings` takes `null` to stop overriding a field and inherit it again; `undefined` leaves it alone. The API expresses that as naming the field in `fields` with no value, which has no natural JavaScript spelling
- Sweep records now carry what the platform has always sent and this SDK dropped on the floor: the trigger (`typeWork`), the fee breakdown (estimated and actual), the gas-pump transaction hash, and the new confirmation fields
- Sweep status tells a broadcast sweep from a settled one. `broadcasted` means the transaction is out and not yet confirmed; `completed` means the chain confirmed it, with the confirmation count and settlement time filled in. Earlier platform versions reported `completed` at broadcast, so a sweep could read as settled while its transaction was unconfirmed or dropped
- Pay-in create accepts `environment` (`mainnet` / `testnet`), which constrains the asset the platform picks in fiat mode and for `ANY` networks — the case where an unconstrained pick could put a real payment on a test chain
- Pay-in create and select-asset accept `master_wallet_address`, pinning the order's deposit wallet to one of the project's master wallets
- The `VERSION` constant used in the User-Agent header was still `0.1.0`, so 0.2.0 introduced itself as 0.1.0. Corrected

## 0.2.0 - 2026-08-18

### Added

- `client.credits.balance()` - signed `POST /v1/credits/balance` returning the
  project's billing credits balance (`CreditsBalance`: credits/USD balance,
  postpaid flag and debt limit, gas-operations gate status). The endpoint is
  billing-exempt (free of charge), so integrations can check credits without
  spending a paid call.
- `client.credits.topup()` - signed `POST /v1/credits/topup` creating a credits
  top-up invoice (`CreditsTopup`: invoice id, hosted `paymentLink`, status) from
  `CreditsTopupParams` (amount, `USDT`/`USDC`, optional success/error redirect
  URLs - omitted from the wire when unset). Billing-exempt (free of charge).

## 0.1.0

- Initial release.

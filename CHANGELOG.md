# Changelog

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

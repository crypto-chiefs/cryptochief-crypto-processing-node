# Changelog

## [0.6.0] — 2026-09-02

Wallets can be named, and the two things about a wallet that were fixed the
moment it was created — where it settles and where it announces its deposits —
can now be changed afterwards.

- `client.wallets.generate()` takes `label`, a human-readable name up to 255 characters. It applies to every wallet type — a label names the wallet, it does not describe its role — and until now a wallet created over the API could only be named later from the panel, one at a time, so anyone minting addresses in bulk got back a list of items indistinguishable from each other. Omitted from the signed body when unset rather than sent as `""`
- `label` now comes back on every response that describes a wallet — generate, `info`, `list` and the three update calls — beside `masterWalletAddress` and `callbackUrl`, all three typed nullable. `null` means the wallet has no name, no master or no webhook; none of them is ever an empty string, so a cleared value reads the same as one that was never set
- `client.wallets.setLabel()` — signed `POST /v1/wallets/label`, renames a wallet or, given `''`, clears the name. The empty string is an instruction here, not an omission, and the SDK puts it on the wire as one; "leave the name alone" is expressed by not calling this at all. Works on every wallet type, unlike the callback URL
- `client.wallets.setCallbackUrl()` — signed `POST /v1/wallets/callback-url`, sets or clears a static wallet's per-deposit webhook after creation; `''` clears it, on the wire for the same reason. Static wallets only — a master or transit address is refused with 400. An address minted outside your own integration announces its deposits wherever it was created to, and nothing could correct that before; a deposit already announced is not announced again to the new URL
- `client.wallets.rebindMaster()` — signed `POST /v1/wallets/rebind-master`, re-points a transit or static wallet at another master of the same project. It moves no money: it decides where the *next* sweep settles, including sweeps already queued when the call lands, and whatever was swept before stays on the previous master. Idempotent, so looping over a list of addresses is safe; the new master has to be the same chain family and unfrozen, and a master wallet cannot be re-pointed
- `LABEL_TOO_LONG` (`ErrorCode.LabelTooLong`) joins the error codes — a name over 255 characters, refused by the gateway with a machine code rather than as a `SERVICE_ERROR` with the reason buried in the message
- Error codes the gateway decides itself now reach the caller. The API writes a refusal in one of two shapes: relayed from an upstream service it is `{"error":"SERVICE_ERROR","msg":"wallet_not_found"}`, with the machine code in `msg`; decided by the gateway it is `{"error":"LABEL_TOO_LONG","msg":"label is longer than 255 characters"}`, with the machine code in `error` and an English sentence in `msg`. `ApiError.code` was read from `msg` first in both cases, so every gateway-side constant this SDK publishes — `LABEL_TOO_LONG`, `INSUFFICIENT_CREDITS`, `DEBT_LIMIT_EXCEEDED`, `INVALID_PARAMS`, `UNAUTHORIZED` and the rest — could never match: the field held a sentence. `code` now comes from `error` unless `error` is the generic `SERVICE_ERROR` marker, and from `msg` when it is, so `err.code === ErrorCode.LabelTooLong` and `isApiError(err, ErrorCode.LabelTooLong)` do what the documentation always said they did
- **Behaviour change** for anyone who worked around that. `ApiError.code` for a gateway-decided refusal used to be the English sentence; it is now the machine code, and a comparison against that sentence — or a `switch` case spelling it out — stops matching. The sentence is still on `err.message`, and `err.raw` still carries the whole body verbatim. Codes arriving in `msg` behind `SERVICE_ERROR` are unaffected

## [0.5.0] — 2026-08-29

The platform now says when swept money has landed, and this SDK stops lying
about which version it is.

- `sweep.confirmed` joins the webhook events: funds swept off a deposit wallet are confirmed on chain in your master wallet. `static_deposit.paid` means a customer paid you; this means the money finished moving into your custody, which is what treasury reporting and "available to pay out" should key off
- The event carries the confirmation count as a field rather than leaving it implied by the event's arrival, because "confirmed" is not the same number of blocks on every chain and a caller with its own finality policy needs the number to apply it
- The `VERSION` constant in the User-Agent header is a second copy of the number in `package.json`, and nothing compared the two. A release could — and elsewhere in this SDK family did — go out announcing a version that had not been published in months. The test suite now fails when they disagree
- The Uniswap example taught a swap that always reverts: the router moves the input token with `transferFrom` and the example never granted the ERC-20 allowance, so it burned the gas and failed. It now signs an approve, executes it and waits for confirmation before signing the swap — the nonce comes from chain state, so signing both up front reserves the same nonce twice — and computes the deadline after that wait. `amountOutMin` was a hard-coded `0n`, which on mainnet in a public mempool means "accept any output"; it is now a required `MIN_OUT`. The README carried the same snippet and now says what a real swap also needs

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

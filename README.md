# Crypto Chief Node.js SDK - Crypto Processing API Client

[![npm](https://img.shields.io/npm/v/@cryptochiefs/cryptochief-crypto-processing-node.svg)](https://www.npmjs.com/package/@cryptochiefs/cryptochief-crypto-processing-node)
[![SDK Docs](https://img.shields.io/badge/docs-SDK%20guide-2ea44f)](https://docs-sdk.crypto-chief.com/processing/js)
[![CI](https://github.com/crypto-chiefs/cryptochief-crypto-processing-node/actions/workflows/ci.yml/badge.svg)](https://github.com/crypto-chiefs/cryptochief-crypto-processing-node/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Crypto Chief Node.js SDK** is the official Node.js / TypeScript client library
for the [Crypto Chief](https://crypto-chief.com/processing/) **crypto processing
API** - a unified crypto payment gateway for accepting crypto payments, sending
crypto payouts (single and mass), signing on-chain transactions, managing
wallets, and verifying webhooks across **Ethereum, Tron, TON, Solana, Bitcoin
and 20+ more blockchains**.

Drop it into any Node.js backend (Express, Fastify, NestJS, serverless ...) to add
cryptocurrency payment processing - stablecoin (USDT / USDC) payouts, pay-ins,
swaps, and smart-contract calls - with fully typed requests, `bigint` amounts,
and `instanceof`-friendly error codes.

- One-line setup; a reusable, stateless `CryptoChiefClient`.
- **First-class TypeScript** - typed request/response for every endpoint.
- **Contract calls without hand-encoded calldata** - Solidity ABI for EVM and
  TRON, Anchor + Borsh for Solana, Jetton / NFT / comment helpers for TON.
- **Local RSA decryption** of generated wallet private keys (opt-in).
- Stable error codes via `ApiError`, automatic retry on transient failures.
- Arbitrary-precision amounts via native `bigint` - never `number`/float.
- Webhook verification + a typed handler for `http` / Express.
- Promise-based polling that resolves when a payout / transaction / pay-in is final.
- **Dual ESM + CommonJS**, ships `.d.ts`. Node 18+ (native `fetch`).

## Install

```bash
npm install @cryptochiefs/cryptochief-crypto-processing-node
```

```ts
// ESM / TypeScript
import { CryptoChiefClient, Chain } from '@cryptochiefs/cryptochief-crypto-processing-node';
// CommonJS
const { CryptoChiefClient, Chain } = require('@cryptochiefs/cryptochief-crypto-processing-node');
```

## Quick start

```ts
import { CryptoChiefClient, Chain } from '@cryptochiefs/cryptochief-crypto-processing-node';

const client = new CryptoChiefClient({
  merchantId: process.env.MERCHANT_ID!,
  apiKey: process.env.API_KEY!, // signing secret - keep it server-side
});

const est = await client.payouts.estimate({
  network: Chain.EthSepolia,
  coin: 'ETH',
  amount: '0.0001',
  toAddress: '0xRecipient...',
});
console.log('amount to receive:', est.amountToReceive);
```

Both credentials come from the dashboard -> Integration tab.

## What you can do with it

| Domain | Service | Key methods |
|---|---|---|
| Single payout (incl. auto-convert swap) | `client.payouts` | `estimate`, `execute`, `info`, `history`, `waitFor` |
| Mass payout (up to 50 items) | `client.payouts` | `batchEstimate`, `batchExecute` |
| Two-phase sign / broadcast for arbitrary txs | `client.transactions` | `sign`, `execute`, `info`, `history`, `waitFor` |
| EVM / TRON contract calls (incl. ERC-20 / TRC-20) | `client.transactions` | `signEvmCall`, `signTronCall`, `erc20Transfer` |
| Solana programs | `client.transactions` | `signAnchorCall`, `signSolanaCall` |
| TON contract calls (Jetton / NFT / text) | `client.transactions` | `jettonTransfer`, `nftTransfer`, `sendTonComment`, `signTonCall` |
| Accept incoming payments | `client.payIns` | `create`, `selectAsset`, `resetAsset`, `cancel`, `info`, `history`, `waitFor` |
| Wallet management + RSA decrypt | `client.wallets` | `generate`, `list`, `info`, `freeze`, `payInHistory`, `rebindMaster`, `setCallbackUrl`, `setLabel`, `decryptPrivateKey` |
| Treasury sweeps | `client.sweeps` | `force`, `history`, `walletHistory`, `settings`, `updateSettings` |
| Withdrawals (read-only) | `client.withdrawals` | `info`, `history` |
| Static-deposit history | `client.staticDeposits` | `info`, `history` |
| On-chain queries | `client.blockchain` | `contractsAvailable`, `contractsList`, `supportedBlockchains`, `walletBalance`, `transactionStatus` |
| Fiat <-> crypto rate quote | `client.currencies` | `fiatToCrypto`, `cryptoToFiat`, `fiats`, `cryptos` |
| Billing credits (free of charge) | `client.credits` | `balance`, `topup` |

## End-to-end example: payout with confirmation

```ts
import { ApiError, ErrorCode } from '@cryptochiefs/cryptochief-crypto-processing-node';

try {
  const exec = await client.payouts.execute({
    orderId: 'order-42', // idempotency key - safe to retry
    userId: 'u-7',
    network: Chain.EthSepolia,
    coin: 'ETH',
    amount: '0.0001',
    toAddress: '0xRecipient...',
    urlCallback: 'https://your.app/webhooks/payout',
  });

  const final = await client.payouts.waitFor(exec.uuid, { intervalMs: 5000, timeoutMs: 300_000 });
  if (final.status === 'paid') console.log('paid: tx =', final.txid);
} catch (err) {
  if (err instanceof ApiError && err.code === ErrorCode.InsufficientFunds) {
    // top up and try again
  } else throw err;
}
```

## Two-phase sign + execute

`transactions.sign` builds and cryptographically signs a transaction **without
broadcasting**. The TTL of the signed reservation varies by chain (EVM 10m, UTXO
15m, TRON 45s, Solana 60s, XRP 90s, TON 300s) - call `execute` before it expires.

```ts
import { TxType, humanToBase } from '@cryptochiefs/cryptochief-crypto-processing-node';

const signed = await client.transactions.sign({
  network: Chain.EthSepolia,
  fromAddress: '0xYourWallet...',
  type: TxType.Native,
  toAddress: '0xRecipient...',
  value: humanToBase('0.0001', 18).toString(), // base units (wei)
  urlCallback: 'https://your.app/webhooks/transaction',
});

await client.transactions.execute({ uuid: signed.uuid });
```

## Contract calls - the easy way

Most real-world transactions are smart-contract calls. You **never** encode the
`data` field by hand: describe the call, get back a signed reservation.

### EVM - Uniswap V2 swap

> **This snippet shows the encoder, not a complete swap.** Uniswap's router
> moves your input token with `transferFrom`, so it needs an ERC-20
> `approve(address,uint256)` on that token first, confirmed before the swap is
> signed — without it the swap reverts and burns the gas. And an `amountOutMin`
> of `0` accepts whatever the pool returns, which on a public mempool hands the
> trade to the first sandwich bot that sees it. The runnable version, with both,
> is in `examples/`.

```ts
const amountIn = humanToBase('0.01', 18);
const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

const signed = await client.transactions.signEvmCall({
  network: Chain.EthMainnet,
  fromAddress: '0xYourWallet...',
  contract: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', // V2 router
  method: 'swapExactTokensForTokens(uint256,uint256,address[],address,uint256)',
  args: [amountIn, 0n, [tokenIn, tokenOut], '0xYourWallet...', deadline],
  urlCallback: 'https://your.app/webhooks/transaction',
});
```

The encoder supports `uint/int<M>`, `address`, `bool`, `bytes`, `bytes<N>`,
`string`, and fixed / dynamic arrays. Integer args accept `bigint`, integer
`number`, or decimal / `0x`-hex strings. Aliases (`uint` -> `uint256`) and named
params (`uint256 amount`) are normalized before hashing.

ERC-20 / TRC-20 transfers have a one-liner:

```ts
const amount = humanToBase('12.5', 6); // USDT decimals = 6
await client.transactions.erc20Transfer({
  network: Chain.EthMainnet,
  fromAddress: '0xYourWallet...',
  tokenContract: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  recipient: '0x...',
  amount,
});
```

### TRON - same encoder, base58 addresses

```ts
await client.transactions.signTronCall({
  network: Chain.TronMainnet,
  fromAddress: 'TYourWallet...',
  contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', // USDT TRC-20 (base58)
  method: 'transfer(address,uint256)',
  args: ['TRecipient...', amount],
});
```

Need to convert addresses outside a call? `tronToHex` / `hexToTron` are exported.

### Solana - Anchor program call

```ts
import { borshU64, borshString, borshPubkey } from '@cryptochiefs/cryptochief-crypto-processing-node';

const signed = await client.transactions.signAnchorCall({
  network: Chain.SolanaMainnet,
  fromAddress: 'YourWallet...',
  program: 'YourProgramId...',
  method: 'initialize',
  args: [borshU64(1_000_000n), borshString('hello'), borshPubkey('Recipient...')],
  accounts: [
    { pubkey: 'YourWallet...', isSigner: true, isWritable: true },
    { pubkey: 'DataAcct...', isSigner: false, isWritable: true },
    { pubkey: '11111111111111111111111111111111', isSigner: false, isWritable: false },
  ],
});
```

Borsh primitives: `borshU8/16/32/64/128`, `borshI8/16/32/64`, `borshBool`,
`borshString`, `borshBytes`, `borshFixedBytes`, `borshPubkey`, `borshOption`,
`borshVec`, `borshStruct`. For non-Anchor programs, pass raw instruction bytes to
`signSolanaCall`.

### TON - Jetton / NFT / comment in one call

TON bodies are program-specific cells with no Solidity-style ABI, so the SDK
encodes them for you (via [`@ton/core`](https://www.npmjs.com/package/@ton/core)).
You describe the operation in human terms.

```ts
const amount = humanToBase('0.5', 6); // USDT Jetton has 6 decimals

await client.transactions.jettonTransfer({
  network: Chain.TonMainnet,
  fromAddress: 'EQYourWallet...',
  jettonMaster: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs', // USDT
  recipient: 'EQRecipient...',
  amount,
  memo: 'Order #4242', // wallets show this as the comment
  // attachedTon omitted -> 0.07 TON if the receiver already has a Jetton wallet
  //                       for this token, 0.15 TON if a new one must be deployed.
});
```

The sender's Jetton wallet address and the gas budget are resolved
automatically. NFT transfers and text comments use the same pattern
(`nftTransfer`, `sendTonComment`). For arbitrary TON contracts, build the body
cell yourself and pass the bytes to `signTonCall({ bodyCell })`.
`parseTonAddress` is exported for offline `EQ...` / `UQ...` / `workchain:hex`
validation.

## Wallets and RSA-encrypted private keys

When the API generates a wallet it returns the private key encrypted with the
RSA public key you uploaded (Project Settings -> RSA Key). The SDK decrypts it
locally:

```bash
openssl genrsa -out rsa_private.pem 2048
openssl rsa -in rsa_private.pem -pubout -out rsa_public.pem   # upload this
```

```ts
import { readFileSync } from 'node:fs';

const client = new CryptoChiefClient({
  merchantId, apiKey,
  rsaPrivateKey: readFileSync('./rsa_private.pem', 'utf8'), // PEM string, Buffer, or KeyObject
});

const w = await client.wallets.generate({ walletType: 'master', chainFamily: 'EVM' });
const privHex = client.wallets.decryptPrivateKey(w.privateKeyEncrypted!); // chain-native hex
```

PKCS#1 and PKCS#8 PEM are both accepted. Without the option, the rest of the SDK
works untouched; only `decryptPrivateKey` requires it (it throws
`RsaKeyNotConfiguredError`).

Three things about a wallet can be changed after it exists - its name, the master
it settles to, and (static wallets only) the deposit webhook it announces to:

```ts
// Name it on creation - any wallet type, up to 255 characters.
const dep = await client.wallets.generate({
  walletType: 'static',
  chainFamily: 'EVM',
  masterWalletAddress: '0xOldMaster...',
  label: 'customer-4242',
});

// Rename it afterwards, or pass '' to take the name away. Any wallet type.
await client.wallets.setLabel(dep.address, 'customer-4242 (EU)');
await client.wallets.setLabel(dep.address, ''); // back to nameless

// Settle the next sweep somewhere else. Moves no money; what was already
// swept stays on the old master. Re-running it changes nothing.
await client.wallets.rebindMaster(dep.address, '0xNewMaster...');

// Point the deposit webhook at a new URL, or pass '' to clear it entirely.
await client.wallets.setCallbackUrl(dep.address, 'https://your.app/webhooks/deposit');
await client.wallets.setCallbackUrl(dep.address, ''); // no more deposit webhooks
```

`label`, `masterWalletAddress` and `callbackUrl` all come back as `null` when the
wallet has none - nobody named it, a master wallet has no master, a transit wallet
never has a callback URL. `label` is on every response that describes a wallet:
generation, info, the list, and each of the three updates above.

## Webhooks

Outbound webhooks are signed with the same algorithm as outgoing requests.

```ts
import express from 'express';
import { parseWebhookEvent, type PayoutWebhookEvent } from '@cryptochiefs/cryptochief-crypto-processing-node';

// IMPORTANT: keep the raw body - do not let a JSON parser touch it first.
app.post('/webhook/payout', express.raw({ type: '*/*' }), (req, res) => {
  try {
    const evt = parseWebhookEvent<PayoutWebhookEvent>(apiKey, req.body, req.header('Signature'));
    console.log('payout', evt.uuid, '->', evt.status);
    res.sendStatus(200);
  } catch {
    res.sendStatus(401); // WebhookSignatureError
  }
});
```

For a plain `http` server, `createWebhookHandler(apiKey, (evt, { res }) => ...)` reads
the raw body and verifies it for you. Low-level `verifyWebhookSignature(apiKey,
rawBody, signature)` returns a boolean (constant-time). `WEBHOOK_SENDER_IPS`
lists the delivery IPs to whitelist at your edge.

Typed payloads: `PayoutWebhookEvent`, `TransactionWebhookEvent`,
`PayInWebhookEvent`, `StaticDepositWebhookEvent`.

## Error handling

API failures are thrown as `ApiError` with a stable `.code`:

```ts
import { ApiError, ErrorCode, isApiError } from '@cryptochiefs/cryptochief-crypto-processing-node';

try {
  await client.payouts.execute(req);
} catch (err) {
  if (isApiError(err, ErrorCode.InsufficientFunds)) { /* need top-up */ }
  else if (err instanceof ApiError) {
    switch (err.code) {
      case ErrorCode.AssetNotEnabled:   // unsupported coin/network
      case ErrorCode.DebtLimitExceeded: // postpaid debt cap hit
      case ErrorCode.FromWalletNotOwned:
      case ErrorCode.AlreadyExecuted:
      default: console.error(err.code, err.httpStatus);
    }
  } else throw err;
}
```

## Amounts

**Never use `number` (float) for crypto amounts.** Use `bigint` via
`humanToBase` / `baseToHuman`:

```ts
import { humanToBase, baseToHuman, nanoTon } from '@cryptochiefs/cryptochief-crypto-processing-node';

humanToBase('1.5', 18);                       // 1500000000000000000n
baseToHuman(1_500_000_000_000_000_000n, 18);  // "1.5"
nanoTon('0.05');                              // 50000000n
```

The API accepts human strings (the `amount` field) and base-unit integer strings
(the `value` field on `/transaction/signature`). Sub-base-unit precision is
truncated, matching every blockchain client.

## Configuration

```ts
const client = new CryptoChiefClient({
  merchantId: 'MERCHANT_ID',
  apiKey: 'API_KEY',
  baseUrl: 'https://api-processing.crypto-chief.com', // default
  timeoutMs: 60_000,                                  // per-attempt
  retries: 3,                                         // 5xx + transport
  retryBackoff: { baseMs: 200, maxMs: 5_000 },
  userAgent: 'my-service/1.0',
  fetch: globalThis.fetch,                            // inject a custom fetch
  logger: { debug: (m, meta) => console.debug(m, meta) },
  rsaPrivateKey: '-----BEGIN PRIVATE KEY-----...',      // optional
});
```

Every method takes an optional `{ signal }` - pass an `AbortSignal` to cancel a
request (and its retries):

```ts
const ac = new AbortController();
setTimeout(() => ac.abort(), 3000);
await client.payouts.info(uuid, { signal: ac.signal });
```

**Test mode** is a per-project toggle in the dashboard, not a separate base URL.

## Idempotency

`payouts.execute` / `payouts.batchExecute` are idempotent on `orderId`:
re-submitting the same `orderId` returns the same `uuid` rather than creating a
second payout. The built-in 5xx retry relies on this - no extra ceremony needed.

## Runnable examples

The [`examples/`](./examples) directory has copy-pasteable programs (run with
`npx tsx examples/<name>.ts`):

`quickstart`, `payout`, `batch-payout`, `sign-execute`, `uniswap-swap`,
`trc20-transfer`, `anchor-call`, `ton-jetton-transfer`, `wallet-generate`,
`webhook-server`.

## FAQ - common crypto-processing tasks in Node.js

**How do I accept a crypto payment in Node.js?**
`client.payIns.create(...)` opens an invoice; the customer gets a deposit address
and you receive a signed webhook when it's paid.

**How do I send a crypto payout (withdrawal) in Node.js / TypeScript?**
`client.payouts.execute(...)` with `coin` / `network` / `amount` / `toAddress`.
Pass `orderId` as the idempotency key and `await client.payouts.waitFor(uuid)`.
Works for native coins and ERC-20 / TRC-20 stablecoins (USDT, USDC).

**How do I send a mass / batch crypto payout?**
`client.payouts.batchExecute(...)` - up to 50 recipients per signed request,
processed sequentially so the double-spend invariant holds.

**How do I call a smart contract (ERC-20, Uniswap) without encoding calldata?**
`client.transactions.signEvmCall(...)`, or `erc20Transfer` for the token-transfer
one-liner. Give it a Solidity signature plus args.

**How do I transfer USDT on TON (a Jetton) in Node?**
`client.transactions.jettonTransfer(...)` - pass the master, recipient, and
amount; the sender's Jetton wallet and gas budget are resolved automatically.

**How do I verify a Crypto Chief webhook signature in Express?**
`parseWebhookEvent(apiKey, rawBody, signature)` (with `express.raw`), or wrap a
plain `http` handler with `createWebhookHandler`.

**How do I control when a deposit wallet is swept?**
`client.sweeps.settings(...)` reads the policy in force for one wallet and
`client.sweeps.updateSettings(...)` changes it - sweep on arrival
(`SweepPolicyMode.Momentum`), sweep once the balance reaches an amount
(`SweepPolicyMode.Threshold` plus `thresholdAmountUsd`), or never on its own
(`SweepPolicyMode.Off`, force still works). The read comes back in three layers -
what will happen, what this wallet overrides, and what it inherits from the
project - so you can tell a value of your own from an inherited one:

```ts
const s = await client.sweeps.updateSettings({
  address: depositAddress,
  typeWork: SweepPolicyMode.Threshold,
  thresholdAmountUsd: '250',
});
// s.effective is the resolved policy; s.effective.source says which layer it came from.
```

Inheritance is per field: overriding the mode leaves the fee mode inherited.
Pass `null` to stop overriding a field and go back to inheriting it.

The four fields a write can name are `typeWork`, `thresholdAmountUsd`, `feeMode`
and `gasSource`; the SDK fills in the API's `fields` mask for you, so `null`
clears exactly one of them and leaves the rest as they were.

**Who pays the network fee for a sweep?**
The deposit wallet, whenever it can. A wallet already holding enough of the
chain's native coin pays for its own transfer whatever `feeMode` says - the mode
only decides who makes up a *shortfall*:

| `feeMode` | Who covers the shortfall |
| --- | --- |
| `SweepFeeMode.Client` | Your own master wallet. |
| `SweepFeeMode.Service` | The platform - and the cost is billed to your API credits. |
| `SweepFeeMode.Mix` | **The default.** Tries `Client` first, falls back to `Service` when the master wallet cannot cover it. |

So `Service` is not free, and `Mix` is not "front it and reclaim it from the
sweep": it is a fallback, and where it falls back to costs credits.

**Who pays for the energy a TRON sweep needs?**
`gasSource`. `SweepGasSource.Native` burns the wallet's own TRX;
`SweepGasSource.Rented` has the platform supply the energy and bills it to your
API credits once the transfer is on chain. TRON only - carried and ignored
elsewhere - and independent of `feeMode`, which answers who covers the network
fee rather than what is bought.

**Not setting it is not the same as setting `native`.** A wallet that never chose
one gets the platform default, which is `rented`, so energy is supplied and
billed without anybody switching it on:

```ts
// Opt out of rented energy - this has to be explicit.
await client.sweeps.updateSettings({ address: tronDeposit, gasSource: SweepGasSource.Native });

// What will actually happen is always a concrete value on `effective`.
const s = await client.sweeps.settings({ address: tronDeposit });
console.log(s.effective.gasSource);   // 'native' | 'rented' - read this one
console.log(s.override?.gasSource);   // null = this layer does not decide, i.e. inherited

// Stop overriding it and inherit again.
await client.sweeps.updateSettings({ address: tronDeposit, gasSource: null });
```

A `null` in the `override` layer means only that the wallet does not decide the
field. It is not "switched off", and reading it in place of `effective.gasSource`
is how a wallet ends up renting energy while its integration believes it burns
its own TRX.

**How do I find a sweep by transaction hash, or list only the failed ones?**
`client.sweeps.history({ status, search })`, and the same two filters on
`client.sweeps.walletHistory({ address, status, search })`. `search` is a
substring match - the wallet address, the sweep or gas-pump transaction hash and
the `task_id` on the project-wide history; the hashes and `task_id` on the wallet
one. Leave `status` off and every status comes back, `SweepStatus.Skipped`
included, which is why an unfiltered page looks busier than the sweeps that
actually moved money.

**A payer gives me an address but no order id - which orders used it?**
`client.wallets.payInHistory({ address })`. It answers with the same order records
and `meta` envelope as `client.payIns.history(...)`, narrowed to that one deposit
wallet, which typically served several orders over its life. The address is
matched case-insensitively, and one that is not your project's yields an empty
page rather than an error.

**Which assets could we turn on, and which chains is the platform watching?**
`client.blockchain.contractsList()` is the platform-wide catalogue - every coin
and token on every network, whatever this project has enabled - in the same row
shape as `contractsAvailable()`, with `chainFamily` and `isTest` on each row and
`contract: ''` (never `null`) for a native coin. `client.blockchain.supportedBlockchains()`
is the infrastructure answer: the chains the block scanner is connected to right
now, returned as a bare array of `{ name, type }`. Neither is your project's
catalogue - that is `contractsAvailable()`, and it is the list that governs
orders, sweeps and payouts.

**Which currencies can I quote a price in?**
`client.currencies.fiats()` is every fiat the platform can price an order in - a
bare array of `{ code, name }`, not an `items` envelope. `client.currencies.cryptos()`
is every crypto ticker it has a rate for against USDT, with `byExchange` mapping
`binance` / `bybit` / `exmo` / `kucoin` to the tickers each one carries.

```ts
const fiats = await client.currencies.fiats();          // [{ code: 'SEK', name: 'Swedish Krona' }, ...]
const { byExchange, quote } = await client.currencies.cryptos();
console.log(quote, Object.keys(byExchange));            // 'USDT' [ 'binance', 'bybit', ... ]
```

Both are **rate availability, not payment availability**. A ticker `cryptos()`
lists can be priced; it does not follow that the platform takes deposits, sweeps
or payouts in it. Build an asset picker from it and you will offer payers assets
the order is then refused for - the list that governs orders, sweeps and payouts
is `client.blockchain.contractsAvailable()`.

An empty catalogue arrives from these three endpoints - `fiats()`,
`supportedBlockchains()` and `cryptos()` - as JSON `null` rather than `[]`. The
SDK normalises it at every level - the whole body, `tickers`, `byExchange`, and
one exchange's own list inside that map - so a method typed as a list always
resolves to one: iterating, mapping or destructuring the result is safe on an
empty answer rather than a `TypeError`.

**How do I re-point a deposit wallet at a different master wallet?**
`client.wallets.rebindMaster(address, newMaster)`. It moves no money - it decides
where the *next* sweep settles, queued sweeps included; whatever was already
swept stays on the old master. Idempotent, so a retry is free. Transit and static
wallets only, and the new master has to be the same chain family and not frozen.

**How do I change or remove a static wallet's deposit webhook after creating it?**
`client.wallets.setCallbackUrl(address, 'https://your.app/webhooks/deposit')`, and
`client.wallets.setCallbackUrl(address, '')` to clear it - the empty string is the
instruction to remove the webhook, and the SDK sends it as one. A deposit already
announced is not announced again to the new URL. Static wallets only.

**How do I give a wallet a human-readable name?**
Pass `label` to `client.wallets.generate(...)`, or name one that already exists with
`client.wallets.setLabel(address, 'customer-4242')`. It works for master, transit and
static wallets alike - unlike the callback URL, nothing here is static-only. Names run
to 255 characters; a longer one is refused with `LABEL_TOO_LONG`.

**How do I take a wallet's name away again?**
`client.wallets.setLabel(address, '')`. The empty string is the instruction to remove
the name, and the SDK sends it as one. It reads back as `label: null` - a wallet has a
name or it has none, and an empty string is never what you get.

**How do I know a sweep actually settled?**
Check `status` together with `sweepConfirmations`. `SweepStatus.Broadcasted`
means the transaction is out and not yet confirmed; `SweepStatus.Completed` plus
`sweepConfirmations` above zero means the chain confirmed it. Earlier platform
versions reported `completed` at broadcast, so a sweep could read as settled
while its transaction was still unconfirmed - the confirmation count separates
the two.

**Not `completedAt`.** It is stamped when the sweep reached a *terminal outcome*,
failures included - a `failed` and a `skipped` sweep both carry one - so its
presence says the sweep finished, not that it succeeded. Book a sweep as money
received off `completedAt` and a failed one is booked as money received. The
moment the chain was seen holding the funds arrives separately, as `confirmedAt`
on the `sweep.confirmed` webhook.

**How do I keep test payments off real chains?**
Set `environment` on `payIns.create` to `Environment.Testnet` or
`Environment.Mainnet`. It constrains the asset the platform picks when you have
not named a concrete network - fiat mode and `ANY` - so an unconstrained pick
cannot put a real payment on a test chain. Omit it to use the project's default.

**Which blockchains does the crypto processing API support?**
Ethereum, BNB Smart Chain, Polygon, Arbitrum, Optimism, Avalanche, Tron, TON,
Solana, Bitcoin, Litecoin, Dogecoin, XRP and more - see the `Chain` constants.

## Documentation

**Full guides, tutorials, and recipes ->
[docs-sdk.crypto-chief.com/processing/js](https://docs-sdk.crypto-chief.com/processing/js)**

- REST / HTTP API reference: [docs-processing.crypto-chief.com](https://docs-processing.crypto-chief.com)

## Contributing

PRs welcome. Run `npm run typecheck`, `npm test`, and `npm run build` before
opening; new endpoints should come with a test exercising the wire shape through
a mocked `fetch`.

## License

MIT - see [LICENSE](LICENSE).

/**
 * Crypto Chief Node.js / TypeScript SDK - the official client for the
 * {@link https://crypto-chief.com/processing/ | Crypto Chief} crypto processing
 * API. Accept crypto payments, send single & mass payouts, sign on-chain
 * transactions, manage wallets, and verify webhooks across Ethereum, Tron, TON,
 * Solana, Bitcoin and 20+ more blockchains.
 *
 * ```ts
 * import { CryptoChiefClient, Chain } from '@cryptochiefs/cryptochief-crypto-processing-node';
 *
 * const client = new CryptoChiefClient({ merchantId: 'M', apiKey: 'K' });
 * const est = await client.payouts.estimate({
 *   network: Chain.EthSepolia, coin: 'ETH', amount: '0.0001', toAddress: '0x...',
 * });
 * ```
 *
 * @packageDocumentation
 */

// Client + configuration
export {
  CryptoChiefClient,
  VERSION,
  DEFAULT_BASE_URL,
  type ClientOptions,
  type RequestOptions,
  type Logger,
  type FetchLike,
} from './client';

// Errors
export {
  CryptoChiefError,
  ApiError,
  ErrorCode,
  type ErrorCodeValue,
  isApiError,
  isRetryable,
} from './errors';

// Request signing (advanced / manual use)
export {
  signHmacV1,
  hmacV1StringToSign,
  hmacV1BodySha256,
  HMAC_V1_SCOPE,
  HMAC_V1_HEADERS,
  HMAC_V1_SIGNATURE_PREFIX,
  type HmacV1Input,
} from './sign';

// Amounts
export { humanToBase, baseToHuman, nanoTon, InvalidAmountError } from './amount';

// Chains
export { Chain, ChainFamily, chainFamily, supportsContractCalls } from './chains';

// Assets / pagination
export type { Asset, AssetsPolicy } from './assets';
export type { HistoryQuery, HistoryMeta } from './pagination';

// Polling
export { waitForTerminal, PollTimeoutError, type PollOptions } from './poll';

// RSA wallet decryption
export {
  loadRsaPrivateKeyPem,
  loadRsaPrivateKeyFile,
  decryptRsaOaep,
  RsaKeyNotConfiguredError,
} from './rsa';

// Webhooks
export {
  verifyWebhook,
  parseWebhookEvent,
  createWebhookHandler,
  signWebhookV1,
  webhookV1StringToSign,
  WebhookVerificationError,
  WEBHOOK_HEADERS,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_SENDER_IPS,
  type WebhookHeaders,
  type WebhookVerifyOptions,
  type WebhookVerificationReason,
  type WebhookHandlerOptions,
  type PayoutWebhookEvent,
  type TransactionWebhookEvent,
  type PayInWebhookEvent,
  type StaticDepositWebhookEvent,
  type SweepWebhookEvent,
  SWEEP_EVENT_CONFIRMED,
  type WebhookEvent,
} from './webhook';

// Services
export * from './services/payouts';
export * from './services/transactions';
export * from './services/payins';
export * from './services/wallets';
export * from './services/sweeps';
export * from './services/withdrawals';
export * from './services/static-deposits';
export * from './services/blockchain';
export * from './services/currencies';
export * from './services/credits';
export * from './services/energy';
export * from './services/native';
export * from './services/webhooks';

// Contract-call encoders
export { encodeEvmCall, encodeEvmCallHex, evmSelector, canonicalSignature } from './contract/evm-abi';
export {
  BorshValue,
  borshU8,
  borshU16,
  borshU32,
  borshU64,
  borshI8,
  borshI16,
  borshI32,
  borshI64,
  borshU128,
  borshBool,
  borshString,
  borshBytes,
  borshFixedBytes,
  borshPubkey,
  borshOption,
  borshVec,
  borshStruct,
  anchorDiscriminator,
  encodeAnchorInstruction,
  decodeSolanaPubkey,
} from './contract/borsh';
export { tronToHex, hexToTron } from './contract/tron-address';
export { base58Encode, base58Decode } from './contract/base58';

// TON address utilities (offline)
export {
  parseTonAddress,
  tonAddressToString,
  tonAddressToRaw,
  crc16Xmodem,
  type TonAddress,
} from './ton/address';

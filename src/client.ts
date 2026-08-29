import { createPrivateKey, type KeyObject } from 'node:crypto';
import { CryptoChiefError, isRetryable } from './errors';
import { signValue } from './sign';
import { backoffDelay, networkError, parseApiError, sleep } from './transport';
import { decryptRsaOaep, RsaKeyNotConfiguredError } from './rsa';
import { TonRpc } from './ton/rpc';
import { PayoutsService } from './services/payouts';
import { TransactionsService } from './services/transactions';
import { PayInsService } from './services/payins';
import { WalletsService } from './services/wallets';
import { SweepsService } from './services/sweeps';
import { WithdrawalsService } from './services/withdrawals';
import { StaticDepositsService } from './services/static-deposits';
import { BlockchainService } from './services/blockchain';
import { CurrenciesService } from './services/currencies';
import { CreditsService } from './services/credits';

/** SDK version, reported in the default `User-Agent`. */
export const VERSION = '0.5.0';

/** Production processing API endpoint. Test-mode projects share this host. */
export const DEFAULT_BASE_URL = 'https://api-processing.crypto-chief.com';

/**
 * Minimal logging surface for debug-level request/response tracing. A no-op by
 * default; pass any object with a matching `debug` method (e.g. a thin wrapper
 * around `pino`/`winston`/`console`).
 */
export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
}

/** The subset of the WHATWG `fetch` signature the client relies on. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ClientOptions {
  /** Merchant ID from the dashboard (Integration tab). Required. */
  merchantId: string;
  /** API key (signing secret) from the dashboard. Keep it server-side. Required. */
  apiKey: string;
  /** API base URL. Defaults to {@link DEFAULT_BASE_URL}. */
  baseUrl?: string;
  /** Per-attempt request timeout in milliseconds. Default 60000. */
  timeoutMs?: number;
  /**
   * Automatic retries for transport failures and 5xx responses. Default 3.
   * Set 0 to disable. Idempotency is provided by `order_id` (payout) and
   * `uuid` (transaction execute), so retries are safe.
   */
  retries?: number;
  /** Backoff tuning. Defaults to base 200ms, cap 5000ms (exponential + jitter). */
  retryBackoff?: { baseMs?: number; maxMs?: number };
  /** `User-Agent` header. Defaults to `cryptochief-node/<version>`. */
  userAgent?: string;
  /** Custom fetch implementation (e.g. for testing or a proxy). Defaults to global `fetch`. */
  fetch?: FetchLike;
  /** Debug logger. Disabled by default. */
  logger?: Logger;
  /**
   * RSA private key (PEM string/Buffer, or a Node `KeyObject`) used by
   * {@link WalletsService.decryptPrivateKey} to decrypt generated wallets'
   * `private_key_encrypted` field. PKCS#1 and PKCS#8 PEM are both accepted.
   * Optional - the rest of the SDK works without it.
   */
  rsaPrivateKey?: string | Buffer | KeyObject;
  /** Override the TON RPC base URL (default `https://rpc.crypto-chief.com`). For staging. */
  tonRpcBaseUrl?: string;
}

/** Per-call options. Pass an `AbortSignal` to cancel the request (and its retries). */
export interface RequestOptions {
  /** Abort the request (and cancel retries) via an `AbortController`/`AbortSignal`. */
  signal?: AbortSignal;
}

/**
 * Entry point to the Crypto Chief processing API. Construct once and reuse -
 * the client is stateless beyond its configuration and safe to share.
 *
 * ```ts
 * const client = new CryptoChiefClient({ merchantId: 'M', apiKey: 'K' });
 * const est = await client.payouts.estimate({
 *   network: Chain.EthSepolia, coin: 'ETH', amount: '0.0001', toAddress: '0x...',
 * });
 * ```
 */
export class CryptoChiefClient {
  readonly merchantId: string;
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly backoff: { baseMs: number; maxMs: number };
  private readonly userAgent: string;
  private readonly fetchImpl: FetchLike;
  private readonly logger?: Logger;

  private readonly rsaKeyInput?: string | Buffer | KeyObject;
  private rsaKeyResolved?: KeyObject;
  private rsaKeyError?: Error;

  private readonly tonRpcBaseUrl?: string;
  private tonRpcInstance?: TonRpc;

  readonly payouts: PayoutsService;
  readonly transactions: TransactionsService;
  readonly payIns: PayInsService;
  readonly wallets: WalletsService;
  readonly sweeps: SweepsService;
  readonly withdrawals: WithdrawalsService;
  readonly staticDeposits: StaticDepositsService;
  readonly blockchain: BlockchainService;
  readonly currencies: CurrenciesService;
  readonly credits: CreditsService;

  constructor(options: ClientOptions) {
    if (!options || !options.merchantId) throw new CryptoChiefError('cryptochief: merchantId is required');
    if (!options.apiKey) throw new CryptoChiefError('cryptochief: apiKey is required');

    this.merchantId = options.merchantId;
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.retries = options.retries ?? 3;
    this.backoff = {
      baseMs: options.retryBackoff?.baseMs ?? 200,
      maxMs: options.retryBackoff?.maxMs ?? 5_000,
    };
    this.userAgent = options.userAgent ?? `cryptochief-node/${VERSION}`;
    this.fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike);
    if (!this.fetchImpl) {
      throw new CryptoChiefError(
        'cryptochief: global fetch is unavailable - use Node 18+ or pass options.fetch',
      );
    }
    this.logger = options.logger;
    this.rsaKeyInput = options.rsaPrivateKey;
    this.tonRpcBaseUrl = options.tonRpcBaseUrl;

    this.payouts = new PayoutsService(this);
    this.transactions = new TransactionsService(this);
    this.payIns = new PayInsService(this);
    this.wallets = new WalletsService(this);
    this.sweeps = new SweepsService(this);
    this.withdrawals = new WithdrawalsService(this);
    this.staticDeposits = new StaticDepositsService(this);
    this.blockchain = new BlockchainService(this);
    this.currencies = new CurrenciesService(this);
    this.credits = new CreditsService(this);
  }

  /**
   * Low-level signed POST against an API path (e.g. `/v1/payout/estimate`).
   * Canonicalizes + signs the body, sends it, retries transient failures, and
   * returns the parsed JSON. Service methods are thin wrappers over this; reach
   * for it directly only to hit an endpoint the SDK doesn't model yet.
   */
  async request<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    const { canonical, signature } = signValue(body, this.apiKey);
    const url = this.baseUrl + path;
    const attempts = this.retries + 1;
    let lastErr: unknown;

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) {
        const delayMs = backoffDelay(attempt, this.backoff.baseMs, this.backoff.maxMs);
        this.logger?.debug('cryptochief retry', { attempt, delayMs, path });
        await sleep(delayMs, opts?.signal); // throws if the caller aborts
      }

      let resp: Response;
      try {
        resp = await this.fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Merchant: this.merchantId,
            Signature: signature,
            'User-Agent': this.userAgent,
          },
          body: canonical,
          signal: this.attemptSignal(opts?.signal),
        });
      } catch (err) {
        if (opts?.signal?.aborted) throw opts.signal.reason ?? err; // caller cancelled
        lastErr = networkError(err instanceof Error ? err.message : String(err));
        if (!isRetryable(lastErr)) throw lastErr;
        continue;
      }

      let text: string;
      try {
        text = await resp.text();
      } catch (err) {
        lastErr = networkError(err instanceof Error ? err.message : String(err));
        if (!isRetryable(lastErr)) throw lastErr;
        continue;
      }

      this.logger?.debug('cryptochief response', { path, status: resp.status, bytes: text.length });

      if (resp.status >= 200 && resp.status < 300) {
        if (text.length === 0) return undefined as T;
        try {
          return JSON.parse(text) as T;
        } catch (err) {
          throw new CryptoChiefError(
            `cryptochief: decode ${path} response: ${err instanceof Error ? err.message : String(err)} (raw=${truncate(text, 512)})`,
          );
        }
      }

      const apiErr = parseApiError(resp.status, text);
      if (resp.status >= 500) {
        lastErr = apiErr;
        continue;
      }
      throw apiErr;
    }

    throw lastErr ?? new CryptoChiefError('cryptochief: retry budget exhausted');
  }

  private attemptSignal(user?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    return user ? AbortSignal.any([user, timeout]) : timeout;
  }

  /** @internal - used by {@link WalletsService.decryptPrivateKey}. */
  rsaDecrypt(encrypted: string): string {
    if (this.rsaKeyError) throw this.rsaKeyError;
    if (this.rsaKeyResolved === undefined) {
      if (this.rsaKeyInput === undefined) throw new RsaKeyNotConfiguredError();
      try {
        this.rsaKeyResolved =
          this.rsaKeyInput instanceof Object && 'asymmetricKeyType' in this.rsaKeyInput
            ? (this.rsaKeyInput as KeyObject)
            : createPrivateKey(this.rsaKeyInput as string | Buffer);
      } catch (err) {
        this.rsaKeyError = new CryptoChiefError(
          `cryptochief: RSA key: ${err instanceof Error ? err.message : String(err)}`,
        );
        throw this.rsaKeyError;
      }
    }
    return decryptRsaOaep(this.rsaKeyResolved, encrypted);
  }

  /** @internal - lazily built TON RPC helper, shares the merchant credential. */
  tonRpc(): TonRpc {
    if (!this.tonRpcInstance) {
      this.tonRpcInstance = new TonRpc({
        merchantId: this.merchantId,
        baseUrl: this.tonRpcBaseUrl,
        fetchImpl: this.fetchImpl,
        userAgent: this.userAgent,
      });
    }
    return this.tonRpcInstance;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '...';
}

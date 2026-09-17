import { createPrivateKey, randomBytes, type KeyObject } from 'node:crypto';
import { CryptoChiefError, ErrorCode, isRetryable } from './errors';
import { HMAC_V1_HEADERS, isBlankApiKey, signHmacV1, upperAsciiMethod } from './sign';
import { encodeRequestBody } from './body';
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
import { WebhooksService } from './services/webhooks';
import { BlockchainService } from './services/blockchain';
import { CurrenciesService } from './services/currencies';
import { CreditsService } from './services/credits';

/** SDK version, reported in the default `User-Agent`. */
export const VERSION = '0.9.0';

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
  /** Merchant ID from the dashboard (Integration tab). Required. Leading and trailing whitespace is ignored. */
  merchantId: string;
  /**
   * API key (signing secret) from the dashboard. Keep it server-side. Required:
   * an empty key, or one of spaces and tabs only, is refused by the server, so
   * the constructor rejects it.
   */
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

/**
 * Per-call options, accepted by every service method and by
 * {@link CryptoChiefClient.request} / {@link CryptoChiefClient.send}.
 */
export interface RequestOptions {
  /** Abort the request (and cancel retries) via an `AbortController`/`AbortSignal`. */
  signal?: AbortSignal;
  /**
   * `Idempotency-Key` header value.
   *
   * The header is part of the string to sign, so it has to be set here: a
   * header added by a `fetch` wrapper is not covered by the signature and the
   * server answers 401 `INVALID_SIGNATURE`.
   *
   * The server keeps the value in the billing record of the call, up to 255
   * bytes. It does not deduplicate payouts - `orderId` does that.
   *
   * The key must be printable ASCII with no space or tab at either edge; the
   * server trims those before signing, so an untrimmed value would be signed in
   * a form it never sees. A key that does not qualify throws
   * {@link CryptoChiefError}; an empty string sends no header.
   */
  idempotencyKey?: string;
}

/** Printable ASCII, no space at either edge; tab and other control bytes nowhere. */
const IDEMPOTENCY_KEY_RE = /^[\x21-\x7e]+(?: +[\x21-\x7e]+)*$/;

function checkedIdempotencyKey(key: string): string {
  if (!IDEMPOTENCY_KEY_RE.test(key)) {
    throw new CryptoChiefError(
      'cryptochief: idempotencyKey must be printable ASCII without a leading or trailing space or tab',
    );
  }
  return key;
}

/**
 * Entry point to the Crypto Chief processing API. Construct once and reuse -
 * the client is safe to share.
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
  /** Seconds added to the local clock for `X-CC-Timestamp`, learned from `server_time`. */
  private clockOffsetSec = 0;

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
  readonly webhooks: WebhooksService;

  constructor(options: ClientOptions) {
    const merchantId = trimHttpWhitespace(String(options?.merchantId ?? ''));
    if (!merchantId) throw new CryptoChiefError('cryptochief: merchantId is required');
    if (isBlankApiKey(options?.apiKey)) throw new CryptoChiefError('cryptochief: apiKey is required');

    this.merchantId = merchantId;
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
    this.webhooks = new WebhooksService(this);
  }

  /**
   * Low-level signed POST against an API path (e.g. `/v1/payout/estimate`) -
   * {@link send} with `POST`. Service methods are thin wrappers over this;
   * reach for it directly only to hit an endpoint the SDK doesn't model yet.
   */
  request<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return this.send<T>('POST', path, body, opts);
  }

  /**
   * Low-level signed request with any HTTP method, for an endpoint the SDK
   * doesn't model yet - a signed `GET` with a query, say:
   *
   * ```ts
   * const info = await client.send('GET', '/v1/payments/order/info?uuid=' + uuid);
   * ```
   *
   * Encodes the body as JSON once, signs every attempt with HMAC v1, retries
   * transient failures, and returns the parsed JSON. The method is signed and
   * sent upper-cased over `a`-`z`; anything that is not an RFC 9110 token
   * throws {@link CryptoChiefError}, as does a body on `GET` or `HEAD`.
   *
   * Object fields that are `null` or `undefined` are not sent; `null` array
   * elements are. A `bigint` is sent as its exact integer. `undefined` and
   * `null` bodies are sent empty. The path is signed percent-decoded, as the
   * server reads it; the query is signed as the URL carries it.
   */
  async send<T>(method: string, path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    const httpMethod = checkedMethod(method);
    const payload = encodeRequestBody(body);
    if (payload !== '' && BODYLESS_METHODS.has(httpMethod)) {
      throw new CryptoChiefError(`cryptochief: a ${httpMethod} request cannot carry a body`);
    }
    const url = this.baseUrl + path;
    const { routePath, query } = signedTarget(url, path);
    const idempotencyKey = opts?.idempotencyKey ? checkedIdempotencyKey(opts.idempotencyKey) : '';
    const attempts = this.retries + 1;
    let lastErr: unknown;
    let clockCorrected = false;
    let skipDelay = false;

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0 && !skipDelay) {
        const delayMs = backoffDelay(attempt, this.backoff.baseMs, this.backoff.maxMs);
        this.logger?.debug('cryptochief retry', { attempt, delayMs, path });
        await sleep(delayMs, opts?.signal); // throws if the caller aborts
      }
      skipDelay = false;

      const timestamp = String(Math.floor(Date.now() / 1000) + this.clockOffsetSec);
      const nonce = randomBytes(16).toString('hex');
      const hmac = signHmacV1(
        {
          timestamp,
          nonce,
          method: httpMethod,
          path: routePath,
          query,
          merchant: this.merchantId,
          idempotencyKey,
          body: payload,
        },
        this.apiKey,
      );
      const headers: Record<string, string> = {
        Accept: 'application/json',
        Merchant: this.merchantId,
      };
      // A body needs application/json; without one the header would be a lie.
      if (payload !== '') headers['Content-Type'] = 'application/json';
      if (idempotencyKey) headers[HMAC_V1_HEADERS.idempotencyKey] = idempotencyKey;
      headers[HMAC_V1_HEADERS.timestamp] = timestamp;
      headers[HMAC_V1_HEADERS.nonce] = nonce;
      headers[HMAC_V1_HEADERS.signature] = 'v1=' + hmac;
      headers['User-Agent'] = this.userAgent;

      let resp: Response;
      try {
        resp = await this.fetchImpl(url, {
          method: httpMethod,
          headers,
          body: payload === '' ? undefined : payload,
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
      if (apiErr.code === ErrorCode.SignatureTimestampOutOfRange && !clockCorrected) {
        const serverTime = apiErr.serverTime;
        if (serverTime !== undefined) {
          clockCorrected = true;
          this.clockOffsetSec = serverTime - Math.floor(Date.now() / 1000);
          this.logger?.debug('cryptochief clock offset', { path, offsetSec: this.clockOffsetSec });
          lastErr = apiErr;
          attempt--; // the correction does not use the retry budget
          skipDelay = true;
          continue;
        }
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

/** Methods `fetch` forbids a body on. */
const BODYLESS_METHODS = new Set(['GET', 'HEAD']);

/** RFC 9110 token: the characters an HTTP method may be made of. */
const HTTP_METHOD_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Method as signed and sent: upper-cased over `a`-`z`, and a token or nothing. */
function checkedMethod(method: string): string {
  const upper = upperAsciiMethod(typeof method === 'string' ? method : '');
  if (!HTTP_METHOD_RE.test(upper)) {
    throw new CryptoChiefError(`cryptochief: HTTP method must be an RFC 9110 token: ${JSON.stringify(method)}`);
  }
  return upper;
}

/**
 * HMAC v1 path and query. The path is the route without query, percent-decoded
 * - the server signs the decoded path, so `/v1/orders/payout%2F8814` is signed
 * as `/v1/orders/payout/8814`. The query is signed as the request URL carries
 * it, encoded.
 */
function signedTarget(url: string, path: string): { routePath: string; query: string } {
  const cut = path.search(/[?#]/);
  const routePath = decodePath(cut < 0 ? path : path.slice(0, cut));
  let query: string;
  try {
    query = new URL(url).search.slice(1);
  } catch {
    const q = path.indexOf('?');
    query = q < 0 ? '' : path.slice(q + 1).split('#')[0]!;
  }
  return { routePath, query };
}

/** Percent-decodes a route path; a `%` that is not a valid UTF-8 escape is an error. */
function decodePath(path: string): string {
  if (!path.includes('%')) return path;
  try {
    return decodeURIComponent(path);
  } catch {
    throw new CryptoChiefError(`cryptochief: path is not valid percent-encoding: ${path}`);
  }
}

/** Strips leading and trailing HTTP whitespace (space, tab, CR, LF), as `fetch` does for header values. */
function trimHttpWhitespace(s: string): string {
  return s.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '...';
}

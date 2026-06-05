import { beginCell, Cell } from '@ton/core';
import { CryptoChiefError } from '../errors';
import type { FetchLike } from '../client';
import { parseTonAddr } from './messages';

/**
 * Internal TON RPC client. Exists only to feed parameters (the sender's Jetton
 * wallet address; whether a recipient already has a Jetton wallet) into the
 * high-level TON sign helpers - it is not part of the public API surface.
 *
 * URL pattern: `<baseUrl>/ton-v3/<merchantId>/<endpoint>`. The merchant ID is
 * the same credential used by the processing API; no separate token.
 */
const DEFAULT_TON_RPC_BASE_URL = 'https://rpc.crypto-chief.com';

export interface TonRpcOptions {
  merchantId: string;
  baseUrl?: string;
  fetchImpl: FetchLike;
  userAgent: string;
}

export class TonRpc {
  private readonly baseUrl: string;
  private readonly merchantId: string;
  private readonly fetchImpl: FetchLike;
  private readonly userAgent: string;
  private readonly jettonWalletCache = new Map<string, string>();

  constructor(opts: TonRpcOptions) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_TON_RPC_BASE_URL).replace(/\/+$/, '');
    this.merchantId = opts.merchantId;
    this.fetchImpl = opts.fetchImpl;
    this.userAgent = opts.userAgent;
  }

  private urlFor(path: string, query?: Record<string, string>): string {
    let u = `${this.baseUrl}/ton-v3/${this.merchantId}/${path.replace(/^\/+/, '')}`;
    if (query && Object.keys(query).length > 0) {
      u += '?' + new URLSearchParams(query).toString();
    }
    return u;
  }

  private async doGet<T>(path: string, query: Record<string, string>, timeoutMs: number): Promise<T> {
    const resp = await this.fetchImpl(this.urlFor(path, query), {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': this.userAgent },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return this.handle<T>(resp, path);
  }

  private async doPost<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
    const resp = await this.fetchImpl(this.urlFor(path), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': this.userAgent,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return this.handle<T>(resp, path);
  }

  private async handle<T>(resp: Response, path: string): Promise<T> {
    const text = await resp.text();
    if (resp.status >= 400) {
      throw new CryptoChiefError(`cryptochief/ton: ${path}: HTTP ${resp.status}: ${text.slice(0, 256)}`);
    }
    if (text.length === 0) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new CryptoChiefError(
        `cryptochief/ton: decode ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Resolve the on-chain Jetton wallet address holding `owner`'s balance of the
   * Jetton minted by `jettonMaster`. Primary path: the deterministic
   * `get_wallet_address` get-method on the master (works even for an owner that
   * never received the Jetton). Fallback: the indexer. Cached for the client's
   * lifetime.
   */
  async lookupJettonWallet(jettonMaster: string, owner: string): Promise<string> {
    if (!jettonMaster || !owner) {
      throw new CryptoChiefError('cryptochief/ton: jettonMaster and owner are required');
    }
    const cacheKey = `${owner}|${jettonMaster}`;
    const cached = this.jettonWalletCache.get(cacheKey);
    if (cached) return cached;

    let resolved = '';
    try {
      resolved = await this.jettonWalletViaRunMethod(jettonMaster, owner);
    } catch {
      resolved = '';
    }
    if (!resolved) {
      resolved = await this.jettonWalletViaIndex(jettonMaster, owner);
    }
    this.jettonWalletCache.set(cacheKey, resolved);
    return resolved;
  }

  private async jettonWalletViaRunMethod(jettonMaster: string, owner: string): Promise<string> {
    const ownerCell = beginCell().storeAddress(parseTonAddr(owner)).endCell();
    const ownerBoc = Buffer.from(ownerCell.toBoc({ idx: false, crc32: false })).toString('base64');
    const out = await this.doPost<{
      exit_code?: number;
      stack?: { type: string; value: string }[];
    }>(
      '/runGetMethod',
      {
        address: jettonMaster,
        method: 'get_wallet_address',
        stack: [{ type: 'slice', value: ownerBoc }],
      },
      15_000,
    );
    if (out.exit_code !== 0 && out.exit_code !== undefined) {
      throw new CryptoChiefError(`cryptochief/ton: get_wallet_address: exit_code=${out.exit_code}`);
    }
    const first = out.stack?.[0];
    if (!first) throw new CryptoChiefError('cryptochief/ton: get_wallet_address: empty stack');
    const resultCell = Cell.fromBoc(Buffer.from(first.value, 'base64'))[0];
    if (!resultCell) throw new CryptoChiefError('cryptochief/ton: get_wallet_address: empty result cell');
    return resultCell.beginParse().loadAddress().toString();
  }

  private async jettonWalletViaIndex(jettonMaster: string, owner: string): Promise<string> {
    const out = await this.doGet<{
      jetton_wallets?: { address: string }[];
      address_book?: Record<string, { user_friendly?: string }>;
    }>('/jetton/wallets', { owner_address: owner, jetton_address: jettonMaster, limit: '1' }, 15_000);
    const wallet = out.jetton_wallets?.[0];
    if (!wallet) {
      throw new CryptoChiefError(
        `cryptochief/ton: no Jetton wallet found for owner ${owner} on master ${jettonMaster} - owner has never received this Jetton`,
      );
    }
    const friendly = out.address_book?.[wallet.address]?.user_friendly;
    return friendly || wallet.address;
  }

  /**
   * Whether `owner` already holds an initialized Jetton wallet for
   * `jettonMaster`. Used to size the attached gas budget on transfers. Returns
   * `false` (the conservative answer) on any RPC error.
   */
  async hasJettonWallet(jettonMaster: string, owner: string): Promise<boolean> {
    try {
      const out = await this.doGet<{ jetton_wallets?: unknown[] }>(
        '/jetton/wallets',
        { owner_address: owner, jetton_address: jettonMaster, limit: '1' },
        5_000,
      );
      return (out.jetton_wallets?.length ?? 0) > 0;
    } catch {
      return false;
    }
  }
}

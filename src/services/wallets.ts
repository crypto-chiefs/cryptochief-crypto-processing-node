import type { Chain, ChainFamily } from '../chains';
import type { RequestOptions } from '../client';
import type { PayInHistoryResponse } from './payins';
import { BaseService } from './base';

/** Wallet role. */
export const WalletType = {
  Master: 'master',
  Transit: 'transit',
  Static: 'static',
} as const;
export type WalletType = (typeof WalletType)[keyof typeof WalletType];

export interface GenerateWalletRequest {
  walletType: WalletType;
  chainFamily: ChainFamily;
  /** Transit/static wallets only. */
  masterWalletAddress?: string;
  /** Static wallets only - per-deposit webhook URL. */
  callbackUrl?: string;
  /**
   * Human-readable name for the wallet, up to 255 characters. Applies to every
   * wallet type - master, transit and static alike, not only static ones.
   * Omitted from the signed body when unset rather than sent as `""`.
   */
  label?: string;
}

export interface WalletCoinBalance {
  address: string;
  chain: Chain;
  coin: string;
  contract?: string;
  decimals: number;
  value: string;
  humanValue: string;
  amountUsd?: string;
  timestamp?: number;
}

export interface Wallet {
  address: string;
  chainFamily: ChainFamily;
  type?: WalletType;
  walletType?: WalletType;
  frozen?: boolean;
  /**
   * The master wallet this one settles to. `null` when it has none - a master
   * wallet itself, most obviously. The wallet-info shape always carries the
   * key, so `null` means "no master", not "not reported"; change it with
   * {@link WalletsService.rebindMaster}.
   */
  masterWalletAddress?: string | null;
  /**
   * Per-deposit webhook URL. `null` when the wallet has none, and always `null`
   * for master and transit wallets - only static wallets carry one. Never an
   * empty string: {@link WalletsService.setCallbackUrl} clears it to `null`.
   */
  callbackUrl?: string | null;
  /**
   * The wallet's human-readable name. `null` when it has none - never an empty
   * string, so a cleared name reads the same as one that was never set. Every
   * wallet type carries the key; change it with {@link WalletsService.setLabel}.
   */
  label?: string | null;
  /** Base64 RSA-OAEP/SHA-256 ciphertext - decrypt with {@link WalletsService.decryptPrivateKey}. */
  privateKeyEncrypted?: string;
  createdAt?: string;
  /** Populated by `info`. */
  coins?: WalletCoinBalance[];
  totalBalanceUsd?: string;
}

export interface ListWalletsResponse {
  items: Wallet[];
}

/**
 * Filter for {@link WalletsService.payInHistory}. Only `address` is required;
 * omitted fields are not sent.
 */
export interface WalletPayInHistoryQuery {
  /**
   * The deposit address to list orders for. Matched case-insensitively, so
   * either spelling of an EVM address works.
   */
  address: string;
  /** Created from, as `YYYY-MM-DDTHH:MM:SS+HH:MM`. */
  dateFrom?: string;
  /** Created to, same format. */
  dateTo?: string;
  /** 1-based page number. Default `1`. */
  page?: number;
  /** Orders per page. Default `20`, maximum `100`. */
  pageSize?: number;
}

/** Wallet management + local RSA private-key decryption. */
export class WalletsService extends BaseService {
  /** Provision a new wallet on the requested chain family. */
  generate(req: GenerateWalletRequest, opts?: RequestOptions): Promise<Wallet> {
    return this.call('/v1/wallets/generate', req, opts);
  }

  /** Every wallet on the project. */
  list(opts?: RequestOptions): Promise<ListWalletsResponse> {
    return this.call('/v1/wallets/list', {}, opts);
  }

  /** Details and current balances of one wallet. */
  info(address: string, opts?: RequestOptions): Promise<Wallet> {
    return this.call('/v1/wallets/info', { address }, opts);
  }

  /** Toggle the frozen flag - the response's `frozen` field is the new state. */
  freeze(address: string, opts?: RequestOptions): Promise<Wallet> {
    return this.call('/v1/wallets/freeze', { address }, opts);
  }

  /**
   * Every pay-in that used one deposit address - the same order records
   * `client.payIns.history()` returns, in the same
   * {@link PayInHistoryResponse} shape, narrowed to a single wallet.
   *
   * A deposit wallet serves several orders over its lifetime, and this is the
   * list of them: the answer when a payer says they sent funds and you have the
   * address but not the order.
   *
   * Scoped to your own project - an address you do not own yields an empty
   * page, not an error.
   */
  payInHistory(query: WalletPayInHistoryQuery, opts?: RequestOptions): Promise<PayInHistoryResponse> {
    return this.call('/v1/wallets/history', query, opts);
  }

  /**
   * Re-point a transit or static wallet at another master wallet of the same
   * project. Returns the wallet as it stands afterwards.
   *
   * This moves no money. It decides where the *next* sweep settles - including
   * sweeps already queued when the call lands; whatever was swept before stays
   * on the previous master.
   *
   * Idempotent: a wallet already bound to `masterWalletAddress` answers 200 and
   * is left as it was. Master wallets cannot be re-pointed, and the new master
   * has to be the same chain family and not frozen.
   */
  rebindMaster(address: string, masterWalletAddress: string, opts?: RequestOptions): Promise<Wallet> {
    return this.call('/v1/wallets/rebind-master', { address, masterWalletAddress }, opts);
  }

  /**
   * Set or clear a static wallet's deposit webhook after it was created.
   * Returns the wallet as it stands afterwards, with `callbackUrl` either the
   * new URL or `null`.
   *
   * Pass `''` to clear it. The empty string is a value here, not an omission,
   * and the SDK puts it on the wire as one.
   *
   * Static wallets only - a master or transit address is refused with 400. A
   * deposit already announced is not announced again to the new URL; the change
   * applies to deposits seen from here on.
   */
  setCallbackUrl(address: string, callbackUrl: string, opts?: RequestOptions): Promise<Wallet> {
    return this.call('/v1/wallets/callback-url', { address, callbackUrl }, opts);
  }

  /**
   * Set or clear a wallet's human-readable name after it was created. Returns
   * the wallet as it stands afterwards, with `label` either the new name or
   * `null`.
   *
   * Pass `''` to clear it. The empty string is a value here, not an omission,
   * and the SDK puts it on the wire as one; what comes back is `null`, because
   * a wallet has a name or it has none.
   *
   * Works on every wallet type - master, transit and static alike, unlike
   * {@link WalletsService.setCallbackUrl}. Names longer than 255 characters are
   * refused with `LABEL_TOO_LONG`.
   */
  setLabel(address: string, label: string, opts?: RequestOptions): Promise<Wallet> {
    return this.call('/v1/wallets/label', { address, label }, opts);
  }

  /**
   * Decrypt a generated wallet's `privateKeyEncrypted` field locally, using the
   * RSA private key configured on the client (`rsaPrivateKey` option). Returns
   * the chain-native hex private key. Throws `RsaKeyNotConfiguredError` if no
   * key was configured.
   *
   * This is synchronous and never touches the network.
   */
  decryptPrivateKey(encrypted: string): string {
    return this.client.rsaDecrypt(encrypted);
  }
}

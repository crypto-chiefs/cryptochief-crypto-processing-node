import type { Chain, ChainFamily } from '../chains';
import type { RequestOptions } from '../client';
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
  masterWalletAddress?: string;
  callbackUrl?: string;
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

import type { Chain } from '../chains';
import type { RequestOptions } from '../client';
import { BaseService } from './base';

export interface AvailableContract {
  network: Chain;
  coin: string;
  contract?: string;
  /** `"native"` or `"token"`. */
  type?: string;
  decimals: number;
}

export interface AvailableContractsResponse {
  items: AvailableContract[];
}

export interface WalletBalanceRow {
  contract?: string;
  address: string;
  value: string;
  humanValue: string;
  decimals: number;
}

export interface TxStatusRow {
  confirmations: number;
  fee?: string;
  humanFee?: string;
  blockNumber?: number;
  status?: string;
}

/** Read-only on-chain queries: enabled assets, balances, tx status. */
export class BlockchainService extends BaseService {
  /**
   * Coins/tokens this project may use. Pass a `network` to scope to one chain,
   * or omit for the full set. Each row's `decimals` is what `humanToBase` /
   * `baseToHuman` need.
   */
  contractsAvailable(network?: Chain, opts?: RequestOptions): Promise<AvailableContractsResponse> {
    return this.call('/v1/blockchain/contracts/available', network ? { network } : {}, opts);
  }

  /** Native + token balances for one or more addresses. */
  walletBalance(
    chain: Chain,
    addresses: string[],
    contracts?: string[],
    opts?: RequestOptions,
  ): Promise<WalletBalanceRow[]> {
    const body: Record<string, unknown> = { chain, addresses };
    if (contracts && contracts.length > 0) body.contracts = contracts;
    return this.call('/v1/blockchain/wallet/balance', body, opts);
  }

  /** Current on-chain state of a transaction by hash. */
  transactionStatus(chain: Chain, hash: string, opts?: RequestOptions): Promise<TxStatusRow[]> {
    return this.call('/v1/blockchain/transaction/status', { chain, hash }, opts);
  }
}

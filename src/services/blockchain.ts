import type { Chain, ChainFamily } from '../chains';
import type { RequestOptions } from '../client';
import { BaseService } from './base';

/**
 * One coin or token on one network. The same row shape comes back from the
 * project's own catalogue ({@link BlockchainService.contractsAvailable}) and
 * from the platform-wide one ({@link BlockchainService.contractsList}).
 */
export interface AvailableContract {
  network: Chain;
  coin: string;
  /**
   * Token contract address, and an EMPTY STRING for a native coin. The key is
   * always sent, so `''` means "this coin has no contract" - it is never `null`
   * and never an error.
   */
  contract?: string;
  /** The network's protocol family, e.g. `EVM` - upper case, as everywhere else. */
  chainFamily?: ChainFamily;
  /** `"native"` or `"token"`. */
  type?: string;
  /** Whether the asset lives on a test network rather than a real one. */
  isTest?: boolean;
  decimals: number;
}

export interface AvailableContractsResponse {
  items: AvailableContract[];
}

/** One chain the platform's block scanner is connected to. */
export interface SupportedBlockchain {
  /** The chain key - the same value {@link Chain} spells, e.g. `ETH_MAINNET`. */
  name: Chain;
  /**
   * The protocol family the scanner reads the chain with, e.g. `"evm"`,
   * `"tron"`, `"solana"`. Lower case, unlike the `chainFamily` field elsewhere
   * in the API - do not compare it against {@link ChainFamily}.
   */
  type: string;
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
   *
   * This is the list that governs orders, sweeps and payouts. For everything
   * the platform *could* be turned on for, see
   * {@link BlockchainService.contractsList}.
   */
  contractsAvailable(network?: Chain, opts?: RequestOptions): Promise<AvailableContractsResponse> {
    return this.call('/v1/blockchain/contracts/available', network ? { network } : {}, opts);
  }

  /**
   * Every coin and token the PLATFORM supports, on every network - regardless
   * of what this project has enabled. Platform-wide, so there is nothing to
   * filter by.
   *
   * Use it to build a "which assets could we turn on" picker; for what the
   * project can be paid in right now, use
   * {@link BlockchainService.contractsAvailable}, which answers with the same
   * row shape.
   */
  contractsList(opts?: RequestOptions): Promise<AvailableContractsResponse> {
    return this.call('/v1/blockchain/contracts/list', {}, opts);
  }

  /**
   * The chains the platform's block scanner is connected to right now.
   *
   * Infrastructure-level: it says which chains the platform can read blocks
   * from, not which assets this project may be paid in - that is
   * {@link BlockchainService.contractsAvailable}.
   *
   * The API answers with a bare JSON array rather than an `items` envelope, so
   * this resolves to the array itself. An empty result comes off the wire as
   * literal `null` rather than `[]`; this normalises it, so the caller always
   * gets an array to iterate.
   */
  async supportedBlockchains(opts?: RequestOptions): Promise<SupportedBlockchain[]> {
    return (await this.call<SupportedBlockchain[] | null>('/v1/blockchains/list', {}, opts)) ?? [];
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

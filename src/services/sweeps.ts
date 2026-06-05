import type { Chain, ChainFamily } from '../chains';
import type { RequestOptions } from '../client';
import type { HistoryMeta } from '../pagination';
import { BaseService } from './base';

/** Filter for sweep history by trigger source. */
export const SweepMode = {
  Auto: 'auto',
  Force: 'force',
} as const;
export type SweepMode = (typeof SweepMode)[keyof typeof SweepMode];

export interface SweepHistoryQuery {
  mode?: SweepMode;
  page?: number;
  pageSize?: number;
}

export interface SweepWalletHistoryQuery extends SweepHistoryQuery {
  address: string;
}

export interface Sweep {
  taskId: string;
  sweepTxHash?: string;
  status: string;
  walletAddress: string;
  chain: Chain;
  chainFamily?: ChainFamily;
  assetSymbol?: string;
  assetType?: string;
  amountHuman?: string;
  gasFeeHuman?: string;
  gasFeeFiat?: string;
  serviceFeeFiat?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface SweepHistoryResponse {
  items: Sweep[];
  meta: HistoryMeta;
}

export interface ForceSweepResponse {
  status: string;
}

/** Treasury sweeps (transit -> master). */
export class SweepsService extends BaseService {
  /**
   * Trigger an immediate transit->master sweep for one address. The status
   * acknowledges acceptance; the resulting {@link Sweep} record appears via
   * {@link walletHistory} once the on-chain tx is built.
   */
  force(address: string, network: Chain, opts?: RequestOptions): Promise<ForceSweepResponse> {
    return this.call('/v1/sweeps/force', { address, networkCode: network }, opts);
  }

  /** Recent sweeps across the whole project. */
  history(query: SweepHistoryQuery = {}, opts?: RequestOptions): Promise<SweepHistoryResponse> {
    return this.call('/v1/sweeps/history', query, opts);
  }

  /** Recent sweeps scoped to one wallet. */
  walletHistory(query: SweepWalletHistoryQuery, opts?: RequestOptions): Promise<SweepHistoryResponse> {
    return this.call('/v1/sweeps/wallet/history', query, opts);
  }
}

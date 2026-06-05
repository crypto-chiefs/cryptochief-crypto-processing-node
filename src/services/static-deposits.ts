import type { Chain, ChainFamily } from '../chains';
import type { RequestOptions } from '../client';
import type { HistoryMeta } from '../pagination';
import { BaseService } from './base';

/** Static-deposit status values. */
export const StaticDepositStatus = {
  InMempool: 'in_mempool',
  ConfirmCheck: 'confirm_check',
  Paid: 'paid',
  Dropped: 'dropped',
  Reorged: 'reorged',
} as const;

export interface StaticDeposit {
  uuid: string;
  status: string;
  network: Chain;
  chainFamily?: ChainFamily;
  coin: string;
  contract?: string;
  decimals?: number;
  toAddress: string;
  fromAddress?: string;
  txHash?: string;
  blockNumber?: number;
  amount: string;
  amountFiat?: string;
  confirmations?: number;
  requiredConfirmations?: number;
  foundInMempool?: boolean;
  logType?: string;
  createdAt?: string;
  updatedAt?: string;
  confirmedAt?: string;
  paidAt?: string;
}

export interface StaticDepositHistoryQuery {
  address?: string;
  status?: string;
  coin?: string;
  network?: Chain;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
}

export interface StaticDepositHistoryResponse {
  items: StaticDeposit[];
  meta: HistoryMeta;
}

/** Read endpoints for deposits on per-customer static wallets. */
export class StaticDepositsService extends BaseService {
  /** Fetch one deposit by uuid. */
  info(uuid: string, opts?: RequestOptions): Promise<StaticDeposit> {
    return this.call('/v1/static-deposit/info', { uuid }, opts);
  }

  /** Paged list of static deposits. */
  history(
    query: StaticDepositHistoryQuery = {},
    opts?: RequestOptions,
  ): Promise<StaticDepositHistoryResponse> {
    return this.call('/v1/static-deposit/history', query, opts);
  }
}

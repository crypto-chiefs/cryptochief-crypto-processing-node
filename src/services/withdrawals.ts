import type { Chain } from '../chains';
import type { RequestOptions } from '../client';
import type { HistoryMeta, HistoryQuery } from '../pagination';
import { BaseService } from './base';

export interface Withdrawal {
  uuid: string;
  status: string;
  network: Chain;
  coin?: string;
  contract?: string;
  amount: string;
  amountFiat?: string;
  fromAddress?: string;
  toAddress?: string;
  txHash?: string;
  createdAt?: string;
  updatedAt?: string;
  confirmedAt?: string;
  error?: string;
}

export interface WithdrawalHistoryResponse {
  items: Withdrawal[];
  meta: HistoryMeta;
}

/**
 * Read-only withdrawal endpoints. The public API does not create withdrawals
 * directly - they are produced by the sweep/treasury system.
 */
export class WithdrawalsService extends BaseService {
  /** Fetch one withdrawal by uuid. */
  info(uuid: string, opts?: RequestOptions): Promise<Withdrawal> {
    return this.call('/v1/withdrawal/info', { uuid }, opts);
  }

  /** Paged list of withdrawals. */
  history(query: HistoryQuery = {}, opts?: RequestOptions): Promise<WithdrawalHistoryResponse> {
    return this.call('/v1/withdrawal/history', query, opts);
  }
}

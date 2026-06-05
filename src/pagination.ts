import type { Chain } from './chains';

/**
 * Common filter for history endpoints with simple pagination (payouts, pay-ins,
 * transactions, withdrawals). Omitted fields are not sent.
 */
export interface HistoryQuery {
  page?: number;
  pageSize?: number;
  status?: string;
  coin?: string;
  network?: Chain;
  dateFrom?: string;
  dateTo?: string;
}

/** Pagination envelope returned by every history endpoint. */
export interface HistoryMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages?: number;
}

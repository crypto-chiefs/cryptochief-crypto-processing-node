import type { Chain } from '../chains';
import type { AssetsPolicy } from '../assets';
import type { RequestOptions } from '../client';
import type { HistoryMeta, HistoryQuery } from '../pagination';
import { waitForTerminal, type PollOptions } from '../poll';
import { BaseService } from './base';

/** Payout status values. Terminal: `paid` (ok); `failed`/`system_fail`/`expired`/`cancel` (fail). */
export const PayoutStatus = {
  Queue: 'queue',
  Process: 'process',
  Paid: 'paid',
  Failed: 'failed',
  SystemFail: 'system_fail',
  Expired: 'expired',
  Cancel: 'cancel',
} as const;

const TERMINAL = new Set<string>([
  PayoutStatus.Paid,
  PayoutStatus.Failed,
  PayoutStatus.SystemFail,
  PayoutStatus.Expired,
  PayoutStatus.Cancel,
]);

/** Whether a payout status is final (no further transitions). */
export function isPayoutTerminal(status: string): boolean {
  return TERMINAL.has(status);
}

export interface EstimatePayoutRequest {
  /** Destination chain (e.g. `Chain.EthSepolia`). */
  network: Chain;
  /** Destination coin symbol (e.g. `"ETH"`, `"USDT"`). */
  coin: string;
  /** Human-readable amount to deliver to the recipient (e.g. `"0.5"`). */
  amount: string;
  /** Recipient address. */
  toAddress: string;
  /** Constrain the source wallets the API may draw from. Empty = API picks. */
  fromAddresses?: string[];
  /** Allow combining multiple wallets to reach the target amount. */
  allowMultipleSources?: boolean;
  /** Turn the payout into a swap - the source asset is converted on the fly. */
  autoConvert?: boolean;
  /** Restrict which source assets auto-convert may draw from. */
  autoConvertPolicy?: AssetsPolicy;
  /** Cap the acceptable network fee (USD-equivalent). */
  maxFeeAmountFiat?: string;
  /** Memo for chains that support it (XRP, TON, ...). */
  memo?: string;
}

/** Execute body. `orderId` is the idempotency key - resubmitting returns the same `uuid`. */
export interface ExecutePayoutRequest extends EstimatePayoutRequest {
  orderId: string;
  userId: string;
  urlCallback: string;
}

export interface PayoutFeeInfo {
  feeMode: string;
  estimatedFiat: string;
  estimatedCoin: string;
  estimatedAsset?: string;
}

export interface PayoutSource {
  address: string;
  amount: string;
  coin?: string;
}

export interface EstimatePayoutResponse {
  network: Chain;
  coin: string;
  amount: string;
  amountToReceive: string;
  toAddress: string;
  feeInfo?: PayoutFeeInfo;
  sources?: PayoutSource[];
  serviceOperations?: Record<string, unknown>[];
  autoConvertApplied?: boolean;
}

export interface PayoutInfo {
  uuid: string;
  orderId: string;
  status: string;
  network: Chain;
  coin: string;
  amount: string;
  toAddress: string;
  txid?: string;
  sources?: PayoutSource[];
  urlCallback?: string;
  createdAt?: string;
  updatedAt?: string;
  error?: string;
}

/** Batch body for `/payout/batch/{estimate,execute}`. Up to 50 items per call. */
export interface BatchPayoutRequest {
  urlCallback?: string;
  items: ExecutePayoutRequest[];
}

export interface BatchItemResult {
  index: number;
  orderId: string;
  status: string;
  uuid?: string;
  error?: string;
}

export interface BatchPayoutResponse {
  batchUuid?: string;
  total: number;
  accepted: number;
  rejected: number;
  items: BatchItemResult[];
}

export interface PayoutHistoryResponse {
  items: PayoutInfo[];
  meta: HistoryMeta;
}

/** Single and mass payout endpoints (including auto-convert swaps). */
export class PayoutsService extends BaseService {
  /** Preview fees and selected source(s) without locking funds. */
  estimate(req: EstimatePayoutRequest, opts?: RequestOptions): Promise<EstimatePayoutResponse> {
    return this.call('/v1/payout/estimate', req, opts);
  }

  /** Create and dispatch a payout. Funds lock immediately; idempotent on `orderId`. */
  execute(req: ExecutePayoutRequest, opts?: RequestOptions): Promise<PayoutInfo> {
    return this.call('/v1/payout/execute', req, opts);
  }

  /** Fetch the current state of one payout by uuid. */
  info(uuid: string, opts?: RequestOptions): Promise<PayoutInfo> {
    return this.call('/v1/payout/info', { uuid }, opts);
  }

  /** Paged list of payouts matching the filter. */
  history(query: HistoryQuery = {}, opts?: RequestOptions): Promise<PayoutHistoryResponse> {
    return this.call('/v1/payout/history', query, opts);
  }

  /** Preview fees for up to 50 payouts in one call. */
  batchEstimate(req: BatchPayoutRequest, opts?: RequestOptions): Promise<BatchPayoutResponse> {
    return this.call('/v1/payout/batch/estimate', req, opts);
  }

  /**
   * Create up to 50 payouts in one call. Bad items return their code in
   * `items[].error` without blocking the rest; funds lock sequentially so an
   * intra-batch double-spend cannot occur.
   */
  batchExecute(req: BatchPayoutRequest, opts?: RequestOptions): Promise<BatchPayoutResponse> {
    return this.call('/v1/payout/batch/execute', req, opts);
  }

  /** Poll `info` until the payout reaches a terminal state (or timeout). */
  waitFor(uuid: string, opts: PollOptions = {}): Promise<PayoutInfo> {
    return waitForTerminal(
      (signal) => this.info(uuid, { signal }),
      (p) => isPayoutTerminal(p.status),
      opts,
    );
  }
}

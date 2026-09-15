import type { Chain } from '../chains';
import type { AssetsPolicy } from '../assets';
import type { RequestOptions } from '../client';
import type { HistoryMeta, HistoryQuery } from '../pagination';
import { waitForTerminal, type PollOptions } from '../poll';
import { BaseService } from './base';

/**
 * Payout status values. Terminal: `paid` (ok); `failed`/`system_fail`/`expired`/`cancel` (fail).
 *
 * Flow: `queue` -> `refueling` -> `refuel_confirmed` -> `sending` ->
 * `confirm_check` -> `paid`. On EVM `broadcasting` follows `sending`, on the
 * Bitcoin family `in_mempool` does.
 */
export const PayoutStatus = {
  /** Waiting to be processed. */
  Queue: 'queue',
  Process: 'process',
  /** Topping up a source wallet with the network's native coin to pay gas. */
  Refueling: 'refueling',
  /** Gas top-up confirmed on chain, or not needed. Ready to send. */
  RefuelConfirmed: 'refuel_confirmed',
  /** Submitting the payout transactions. */
  Sending: 'sending',
  /** EVM: the transaction is queued for broadcast and has no hash yet. */
  Broadcasting: 'broadcasting',
  /** Bitcoin family: broadcast and waiting in the mempool for a block. */
  InMempool: 'in_mempool',
  /** On the network; some source is below `requiredConfirmations`. */
  ConfirmCheck: 'confirm_check',
  /** Every source reached `requiredConfirmations`. */
  Paid: 'paid',
  Failed: 'failed',
  /** The payout failed. */
  SystemFail: 'system_fail',
  Expired: 'expired',
  Cancel: 'cancel',
} as const;
export type PayoutStatus = (typeof PayoutStatus)[keyof typeof PayoutStatus];

const TERMINAL = new Set<string>([
  PayoutStatus.Paid,
  PayoutStatus.Failed,
  PayoutStatus.SystemFail,
  PayoutStatus.Expired,
  PayoutStatus.Cancel,
]);

/** Default `timeoutMs` of {@link PayoutsService.waitFor}: 90 minutes. */
const PAYOUT_WAIT_TIMEOUT_MS = 90 * 60_000;

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
  /** Estimated fee, USD. */
  estimatedFiat?: string;
  limitFiat?: string;
  limitCurrency?: string;
  /** Total fee paid, USD. Absent until the payout is `paid`; never on `estimate`. */
  totalFeePaidFiat?: string;
  /** @deprecated Never sent by the API; always undefined. */
  estimatedCoin?: string;
  /** @deprecated Never sent by the API; always undefined. */
  estimatedAsset?: string;
}

/** One wallet a payout draws on. */
export interface PayoutSource {
  address: string;
  network?: Chain;
  coin?: string;
  /** Amount taken from this wallet, in coin units. */
  amountCrypto: string;
  /** @deprecated Not sent by the API; use `amountCrypto`. */
  amount?: string;
  /** Whether the wallet needs a gas top-up first. */
  needRefuel?: boolean;
  /** Size of that top-up, in the chain's native coin. */
  refuelAmount?: string;
  estimatedFee?: string;
  estimatedFeeFiat?: string;
  /** Fee actually paid. Absent until the transaction is sent. */
  feePaid?: string;
  feePaidFiat?: string;
  /** Hash of this source's transaction. Absent until it is sent. */
  txid?: string;
  /** Confirmations of this source's transaction. Absent until it is on chain. */
  confirmations?: number;
}

/** A transaction the platform makes to carry out a payout, such as a gas top-up (`type` `gas_refuel`). */
export interface PayoutServiceOperation {
  type: string;
  context?: string;
  status: string;
  network?: Chain;
  /** The chain's native coin. */
  coin?: string;
  amountNative?: string;
  fromAddress?: string;
  toAddress?: string;
  estimatedFee?: string;
  estimatedFeeFiat?: string;
  feePaid?: string;
  feePaidFiat?: string;
  txid?: string;
  /** Confirmations of this transaction. Absent until it is on chain. */
  confirmations?: number;
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

/** A payout, as returned by `execute`, `info` and as each item of `history`. */
export interface PayoutInfo {
  uuid: string;
  orderId: string;
  userId?: string;
  /** One of {@link PayoutStatus}. */
  status: PayoutStatus | string;
  /** Amount requested in `execute`, in coin units. */
  amountRequested?: string;
  /** Amount the recipient receives, in coin units. */
  amountToReceive?: string;
  toAddress: string;
  feeInfo?: PayoutFeeInfo;
  /** Wallets the payout draws on; each carries its own `txid`. */
  sources?: PayoutSource[];
  serviceOperations?: PayoutServiceOperation[];
  /** The lowest confirmation count among `sources`. Absent while no source has a transaction. */
  confirmations?: number;
  /** The network's finality depth. The payout is `paid` once every source reaches it. */
  requiredConfirmations?: number;
  createdAt?: string;
  completedAt?: string | null;

  /** @deprecated Never sent by the API; always `undefined`. Use `sources[].network`. */
  network?: Chain;
  /** @deprecated Never sent by the API; always `undefined`. Use `sources[].coin`. */
  coin?: string;
  /** @deprecated Never sent by the API; always `undefined`. Use `amountRequested` or `amountToReceive`. */
  amount?: string;
  /** @deprecated Never sent by the API; always `undefined`. Use `sources[].txid`. */
  txid?: string;
  /** @deprecated Never sent by the API; always `undefined`. */
  urlCallback?: string;
  /** @deprecated Never sent by the API; always `undefined`. Use `completedAt`. */
  updatedAt?: string;
  /** @deprecated Never sent by the API; always `undefined`. */
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

  /**
   * Poll `info` until the payout reaches a terminal state or `timeoutMs` passes
   * (default 90 minutes). `paid` comes at `requiredConfirmations`, which takes about
   * 60 minutes on BITCOIN_CASH_MAINNET. A `PollTimeoutError` does not mean the
   * payout failed: read `lastState.status` and do not resubmit.
   */
  waitFor(uuid: string, opts: PollOptions = {}): Promise<PayoutInfo> {
    return waitForTerminal(
      (signal) => this.info(uuid, { signal }),
      (p) => isPayoutTerminal(p.status),
      { ...opts, timeoutMs: opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : PAYOUT_WAIT_TIMEOUT_MS },
    );
  }
}

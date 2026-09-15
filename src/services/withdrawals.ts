import type { Chain } from '../chains';
import type { RequestOptions } from '../client';
import type { HistoryMeta, HistoryQuery } from '../pagination';
import { BaseService } from './base';

/**
 * Withdrawal status values. Terminal: `completed` (ok); `failed` (fail).
 *
 * Flow: `queue` -> `refueling` -> `refuel_confirmed` -> `sending` ->
 * `confirm_check` -> `completed`. On EVM `broadcasting` follows `sending`, on the
 * Bitcoin family `in_mempool` does.
 */
export const WithdrawalStatus = {
  /** Waiting to be processed. */
  Queue: 'queue',
  /** Topping up the source wallet with the network's native coin to pay gas. */
  Refueling: 'refueling',
  /** Gas top-up confirmed on chain, or not needed. Ready to send. */
  RefuelConfirmed: 'refuel_confirmed',
  /** Submitting the withdrawal transaction. */
  Sending: 'sending',
  /** EVM: the transaction is queued for broadcast and has no hash yet. */
  Broadcasting: 'broadcasting',
  /** Bitcoin family: broadcast and waiting in the mempool for a block. */
  InMempool: 'in_mempool',
  /** On the network, below `requiredConfirmations`. */
  ConfirmCheck: 'confirm_check',
  /** The transaction reached `requiredConfirmations`. */
  Completed: 'completed',
  /** The withdrawal failed; `errorReason` says why. */
  Failed: 'failed',
  /** @deprecated Not reachable through the API. */
  Cancelled: 'cancelled',
} as const;
export type WithdrawalStatus = (typeof WithdrawalStatus)[keyof typeof WithdrawalStatus];

const TERMINAL = new Set<string>([
  WithdrawalStatus.Completed,
  WithdrawalStatus.Failed,
  WithdrawalStatus.Cancelled,
]);

/** Whether a withdrawal status is final (no further transitions). */
export function isWithdrawalTerminal(status: string): boolean {
  return TERMINAL.has(status);
}

/** A withdrawal, as returned by `info` and as each item of `history`. */
export interface Withdrawal {
  uuid: string;
  /** One of {@link WithdrawalStatus}. */
  status: WithdrawalStatus | string;
  network: Chain;
  coin?: string;
  amount: string;
  fromAddress?: string;
  toAddress?: string;
  /** Whether the source wallet had to be topped up with gas first. */
  needRefuel?: boolean;
  /** Hash of the gas top-up transaction. Absent when no top-up was sent. */
  refuelTxHash?: string;
  /** State of the gas top-up (`broadcasting`, `sent`, `done`). Absent when no top-up was sent. */
  refuelStatus?: string;
  /** Hash of the withdrawal transaction. Absent until it has one. */
  txHash?: string;
  /** Confirmations of the withdrawal transaction. Absent until it is in a block; `0` if it has left the block. */
  confirmations?: number;
  /** Always sent. The network's finality depth: `completed` once `confirmations` reaches it. */
  requiredConfirmations?: number;
  /** Why the withdrawal failed. Absent otherwise. */
  errorReason?: string;
  /** Estimated fee in USD at creation. */
  estimatedFeeFiat?: string;
  /** Fee paid, in USD. Absent until `completed`. */
  actualFeeFiat?: string;
  /** Who pays the network fee: `client`, `service` or `mix`. */
  feeMode?: string;
  createdAt?: string;
  /** When the withdrawal became `completed`. */
  completedAt?: string;

  /** @deprecated Never sent by the API; always `undefined`. */
  contract?: string;
  /** @deprecated Never sent by the API; always `undefined`. */
  amountFiat?: string;
  /** @deprecated Never sent by the API; always `undefined`. */
  updatedAt?: string;
  /** @deprecated Never sent by the API; always `undefined`. Use `completedAt`. */
  confirmedAt?: string;
  /** @deprecated Never sent by the API; always `undefined`. Use `errorReason`. */
  error?: string;
}

export interface WithdrawalHistoryResponse {
  items: Withdrawal[];
  meta: HistoryMeta;
}

/**
 * Read-only withdrawal endpoints. Withdrawals are started from the dashboard and
 * have no webhooks.
 */
export class WithdrawalsService extends BaseService {
  /** Fetch one withdrawal by uuid. */
  info(uuid: string, opts?: RequestOptions): Promise<Withdrawal> {
    return this.call('/v1/withdrawal/info', { uuid }, opts);
  }

  /** Paged list of withdrawals, newest first. */
  history(query: HistoryQuery = {}, opts?: RequestOptions): Promise<WithdrawalHistoryResponse> {
    return this.call('/v1/withdrawal/history', query, opts);
  }
}

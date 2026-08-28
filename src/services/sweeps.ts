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

/**
 * Sweep status.
 *
 * A sweep is broadcast first and confirmed after: `Broadcasted` means the
 * transaction is out and not yet confirmed, `Completed` means the chain
 * confirmed it. The platform used to report `completed` at broadcast, so a
 * sweep could read as settled while its transaction was still unconfirmed or
 * had been dropped.
 *
 * `Skipped` is a sweep the platform decided against - almost always a balance
 * below the wallet's threshold. A normal outcome, not a failure.
 */
export const SweepStatus = {
  Pending: 'pending',
  WaitingGas: 'waiting_gas',
  Broadcasted: 'broadcasted',
  Completed: 'completed',
  Failed: 'failed',
  Skipped: 'skipped',
} as const;
export type SweepStatus = (typeof SweepStatus)[keyof typeof SweepStatus];

export interface Sweep {
  taskId: string;
  sweepTxHash?: string;
  gasPumpTxHash?: string;
  status: SweepStatus | string;
  walletAddress: string;
  chain: Chain;
  chainFamily?: ChainFamily;
  assetSymbol?: string;
  assetType?: string;
  amountHuman?: string;
  /** What triggered this sweep: momentum, threshold or force. */
  typeWork?: string;

  /**
   * Confirmations seen on the sweep transaction, and when it reached the
   * network's confirmation target. Read them with {@link status}: `completedAt`
   * is absent while the sweep is still in flight.
   */
  sweepConfirmations?: number;
  completedAt?: string;

  /**
   * Fees. `totalFeeUsd` is the whole cost of the sweep; the gas-pump half is
   * the funding transfer that pays for it on chains needing one. The `real*`
   * figures are what the chain actually charged, filled in once the transaction
   * settles; the others are the estimate made up front.
   */
  totalFeeUsd?: string;
  gasPumpSource?: string;
  gasPumpFeeHuman?: string;
  gasPumpFeeUsd?: string;
  sweepFeeHuman?: string;
  sweepFeeUsd?: string;
  realGasPumpFeeHuman?: string;
  realGasPumpFeeUsd?: string;
  realSweepFeeHuman?: string;
  realSweepFeeUsd?: string;

  createdAt?: string;

  /**
   * @deprecated never populated. The API reports fees under the names above;
   * these were guesses at a shape it does not send.
   */
  gasFeeHuman?: string;
  /** @deprecated never populated. */
  gasFeeFiat?: string;
  /** @deprecated never populated. */
  serviceFeeFiat?: string;
  /** @deprecated never populated - sweeps carry `createdAt` and `completedAt`. */
  updatedAt?: string;
}

/**
 * Auto-sweep modes.
 *
 * - `Off`: never swept on its own. {@link SweepsService.force} still works.
 * - `Momentum`: swept as soon as funds arrive.
 * - `Threshold`: swept once the balance reaches `thresholdAmountUsd`. A held
 *   balance is re-checked periodically, so a wallet that crosses the threshold
 *   through price movement alone is still swept.
 */
export const SweepPolicyMode = {
  Off: 'turned_off',
  Momentum: 'momentum',
  Threshold: 'threshold',
} as const;
export type SweepPolicyMode = (typeof SweepPolicyMode)[keyof typeof SweepPolicyMode];

/**
 * Who pays the gas for a sweep.
 *
 * - `Client`: taken from the swept wallet itself.
 * - `Service`: paid by the platform's service wallet.
 * - `Mix`: the service wallet funds the gas, reclaimed from the sweep.
 */
export const SweepFeeMode = {
  Client: 'client',
  Service: 'service',
  Mix: 'mix',
} as const;
export type SweepFeeMode = (typeof SweepFeeMode)[keyof typeof SweepFeeMode];

/** A resolved set of sweep rules. */
export interface SweepPolicy {
  typeWork: SweepPolicyMode | string;
  /** Meaningful only when `typeWork` is `threshold`. */
  thresholdAmountUsd?: string;
  feeMode: SweepFeeMode | string;
  /**
   * Which layer the mode came from: `wallet_network`, `wallet`, `project` or
   * `default`. Present on {@link SweepSettings.effective}, where the question
   * arises.
   */
  source?: string;
}

/**
 * What one wallet decides for itself. A `null` field is not overridden - it is
 * inherited, which no ordinary value can express.
 */
export interface SweepOverride {
  /**
   * Empty covers the address on every network it exists on; set, it covers that
   * one network and takes precedence over the address-wide override.
   */
  networkCode: string;
  typeWork: string | null;
  thresholdAmountUsd: string | null;
  feeMode: string | null;
  /** Who wrote it: `merchant` or `operator`. */
  source: string;
  /**
   * An operator pinned this policy. While it is set, a merchant write answers
   * `SWEEP_SETTINGS_LOCKED` and changes nothing.
   */
  locked: boolean;
}

/**
 * Three layers, on purpose.
 *
 * `effective` is what will actually happen, `override` is what this wallet
 * decides for itself (null if it decides nothing), `projectDefault` is what it
 * falls back to. Only the three together answer "is this value mine or
 * inherited" - the difference between changing it here and changing it on the
 * project. Inheritance is per field: a wallet can override the mode and keep
 * inheriting the fee mode.
 */
export interface SweepSettings {
  walletAddress?: string;
  networkCode?: string;
  effective: SweepPolicy;
  override: SweepOverride | null;
  projectDefault: SweepPolicy;
}

/** An empty `address` asks for the project's own default rather than a wallet's. */
export interface SweepSettingsQuery {
  address?: string;
  networkCode?: Chain;
}

/**
 * A sweep-policy write.
 *
 * `undefined` leaves a field alone. `null` stops overriding it and goes back to
 * inheriting - the only way to drop one field while keeping the others.
 */
export interface SweepSettingsUpdate {
  address: string;
  networkCode?: Chain;
  typeWork?: SweepPolicyMode | string | null;
  thresholdAmountUsd?: string | null;
  feeMode?: SweepFeeMode | string | null;
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

  /**
   * The auto-sweep policy in force for one wallet, together with what it
   * overrides and what it inherits.
   *
   * Scoped to the caller's own wallets: an address that is not the project's
   * answers `WALLET_NOT_FOUND`.
   */
  settings(query: SweepSettingsQuery = {}, opts?: RequestOptions): Promise<SweepSettings> {
    return this.call('/v1/sweeps/settings', query, opts);
  }

  /**
   * Write a wallet's auto-sweep policy. Returns the settings as they stand
   * afterwards, so the caller sees what the write resolved to without asking
   * again.
   *
   * Refusals are named: `TYPE_WORK_INVALID`, `FEE_MODE_INVALID`,
   * `THRESHOLD_INVALID`, `THRESHOLD_MUST_BE_POSITIVE`,
   * `THRESHOLD_REQUIRED_FOR_THRESHOLD_MODE`, and `SWEEP_SETTINGS_LOCKED` when
   * an operator has pinned the policy.
   */
  updateSettings(update: SweepSettingsUpdate, opts?: RequestOptions): Promise<SweepSettings> {
    // The API spells "stop overriding this field" as naming it in `fields` with
    // no value - a shape with no natural JavaScript equivalent. `null` has one,
    // so the translation lives here rather than in every caller.
    const { address, networkCode, ...policy } = update;
    const body: Record<string, unknown> = { address, networkCode };
    const fields: string[] = [];

    const wireNames: Record<string, string> = {
      typeWork: 'type_work',
      thresholdAmountUsd: 'threshold_amount_usd',
      feeMode: 'fee_mode',
    };
    for (const [key, wireName] of Object.entries(wireNames)) {
      const value = (policy as Record<string, unknown>)[key];
      if (value === undefined) continue;
      fields.push(wireName);
      if (value !== null) body[key] = value;
    }
    if (fields.length > 0) body.fields = fields;

    return this.call('/v1/sweeps/settings/update', body, opts);
  }
}

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
  /**
   * One {@link SweepStatus}. Omit it and every status is included, `skipped`
   * ones among them - which is why an unfiltered page looks busier than the
   * sweeps that actually moved money.
   */
  status?: SweepStatus | string;
  /**
   * Substring match on the wallet address, the sweep or gas-pump transaction
   * hash, and `task_id`.
   */
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface SweepWalletHistoryQuery extends SweepHistoryQuery {
  address: string;
  /**
   * Substring match on the sweep or gas-pump transaction hash and `task_id`.
   * The wallet is already fixed by `address`, so unlike the project-wide
   * history this one does not search addresses.
   */
  search?: string;
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

  /** Confirmations seen on the sweep transaction. `0` until it is mined. */
  sweepConfirmations?: number;
  /**
   * When the sweep reached a TERMINAL OUTCOME - failures included. The sweeper
   * stamps it on `failed` and `skipped` exactly as it does on `completed`, so
   * its presence says the sweep finished, not that it succeeded.
   *
   * **Do not read it as settlement.** For that, check `sweepConfirmations` is
   * above zero, or take `confirmedAt` off the `sweep.confirmed` webhook - which
   * carries a separate field precisely because this one does not answer the
   * question.
   */
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
 * Who covers the gas for a sweep when the deposit wallet cannot.
 *
 * A deposit wallet that already holds enough of the chain's native coin pays
 * for its own transfer whatever this is set to. The mode only decides who makes
 * up a shortfall:
 *
 * - `Client`: your own master wallet fronts it.
 * - `Service`: the platform supplies it, and the cost is BILLED TO YOUR API
 *   CREDITS.
 * - `Mix`: **the default.** Tries `Client` first and falls back to `Service`
 *   when the master wallet cannot cover it.
 */
export const SweepFeeMode = {
  Client: 'client',
  Service: 'service',
  Mix: 'mix',
} as const;
export type SweepFeeMode = (typeof SweepFeeMode)[keyof typeof SweepFeeMode];

/**
 * What buys the energy a TRON transfer needs.
 *
 * - `Native`: the wallet burns its own TRX for it.
 * - `Rented`: the platform supplies the energy, billed to your API credits
 *   once the transfer is on chain.
 *
 * TRON only - the value is carried and ignored on every other chain. It answers
 * a different question from {@link SweepFeeMode} (what is bought, rather than
 * who covers the network fee), so the two are independent and energy can be
 * supplied under any fee mode.
 *
 * **Not setting it is not the same as setting `Native`.** A wallet that never
 * chose one gets the platform default, which is `Rented` - so energy is
 * supplied, and billed to your credits, without anybody having switched it on.
 * To have the wallet burn its own TRX, send `Native` explicitly.
 */
export const SweepGasSource = {
  Native: 'native',
  Rented: 'rented',
} as const;
export type SweepGasSource = (typeof SweepGasSource)[keyof typeof SweepGasSource];

/** A resolved set of sweep rules. */
export interface SweepPolicy {
  typeWork: SweepPolicyMode | string;
  /** Meaningful only when `typeWork` is `threshold`. */
  thresholdAmountUsd?: string;
  feeMode: SweepFeeMode | string;
  /**
   * What buys the energy on TRON - see {@link SweepGasSource}. Required, like
   * its siblings above, because a resolved policy always carries a concrete
   * one: on {@link SweepSettings.effective} this is the field to read, and a
   * wallet that never chose one reads `rented` there, that being the platform
   * default. The layer where "not decided" is expressible is
   * {@link SweepOverride}, where it is nullable.
   */
  gasSource: SweepGasSource | string;
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
  /**
   * What buys the energy on TRON - see {@link SweepGasSource}. `null` means
   * this layer does not decide it: the value is INHERITED, not switched off, so
   * `null` here is not "burn the wallet's own TRX". What will actually happen
   * is {@link SweepSettings.effective}'s `gasSource`.
   */
  gasSource: string | null;
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
  /**
   * What buys the energy on TRON - see {@link SweepGasSource}. Leaving it
   * `undefined` does not mean `native`: it leaves the stored value alone, and
   * where nothing is stored the platform default `rented` applies. Send
   * `SweepGasSource.Native` to opt out of rented energy, and `null` to stop
   * overriding the field and inherit it again.
   */
  gasSource?: SweepGasSource | string | null;
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

  /**
   * Recent sweeps across the whole project, narrowed by trigger (`mode`),
   * outcome (`status`) or a `search` substring over the wallet address, the
   * sweep and gas-pump transaction hashes and `task_id`.
   */
  history(query: SweepHistoryQuery = {}, opts?: RequestOptions): Promise<SweepHistoryResponse> {
    return this.call('/v1/sweeps/history', query, opts);
  }

  /**
   * Recent sweeps scoped to one wallet. Takes the same `mode`, `status` and
   * `search` filters as {@link history}; `search` here matches the transaction
   * hashes and `task_id`, the address being fixed already.
   */
  walletHistory(query: SweepWalletHistoryQuery, opts?: RequestOptions): Promise<SweepHistoryResponse> {
    return this.call('/v1/sweeps/wallet/history', query, opts);
  }

  /**
   * The auto-sweep policy in force for one wallet, together with what it
   * overrides and what it inherits.
   *
   * Read `effective.gasSource` for what will actually pay for TRON energy; a
   * `null` in `override` says only that the wallet does not decide it.
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
   * Inheritance is per field: writing the mode leaves the fee mode inherited.
   * The four fields that can be written - and so the four names the API's
   * `fields` mask accepts, which this method fills in for you - are `type_work`,
   * `threshold_amount_usd`, `fee_mode` and `gas_source`.
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
      gasSource: 'gas_source',
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

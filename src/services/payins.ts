import type { Chain, ChainFamily } from '../chains';
import type { Asset, AssetsPolicy } from '../assets';
import type { RequestOptions } from '../client';
import type { HistoryMeta, HistoryQuery } from '../pagination';
import { waitForTerminal, type PollOptions } from '../poll';
import { BaseService } from './base';

/** Pay-in mode: `fiat` fixes a stable fiat price; `crypto` fixes the crypto amount. */
export const PayInMode = {
  Fiat: 'fiat',
  Crypto: 'crypto',
} as const;
export type PayInMode = (typeof PayInMode)[keyof typeof PayInMode];

/** Pay-in status values. */
export const PayInStatus = {
  WaitingAssetSelect: 'waiting_asset_select',
  Pending: 'pending',
  Processing: 'processing',
  Process: 'process',
  Paid: 'paid',
  Cancel: 'cancel',
  Expired: 'expired',
} as const;

const TERMINAL = new Set<string>([PayInStatus.Paid, PayInStatus.Cancel, PayInStatus.Expired]);

/** Whether a pay-in status is final. */
export function isPayInTerminal(status: string): boolean {
  return TERMINAL.has(status);
}

/**
 * The two environments an order can belong to. A project may be allowed one or
 * both; asking for testnet on a project that does not permit it is refused with
 * `TESTNET_NOT_ALLOWED` rather than quietly served on mainnet, and a value that
 * is neither is `ENVIRONMENT_INVALID` rather than a silent fallback.
 */
export const Environment = {
  Mainnet: 'mainnet',
  Testnet: 'testnet',
} as const;
export type Environment = (typeof Environment)[keyof typeof Environment];

export interface CreatePayInRequest {
  orderId: string;
  userId: string;
  mode: PayInMode;
  toAddress?: string;
  /**
   * Pin the transit deposit wallet of THIS order to the given master wallet of
   * the project - the address the funds are swept to. The order's asset/network
   * chain family must match the master wallet's; a foreign or mismatched address
   * is rejected with 400. Omit for the project-default behaviour.
   */
  masterWalletAddress?: string;
  /**
   * Constrain the asset the platform PICKS for this order to the real chains or
   * the test ones. Omit to use the project's own default.
   *
   * It changes nothing when `asset` names a concrete network - that is the
   * caller's choice. It matters in fiat mode and when the network is `ANY`,
   * where the platform selects the asset and an unconstrained pick could put a
   * real payment on a test network.
   */
  environment?: Environment | string;
  lifetimeSec?: number;
  urlCallback?: string;
  urlSuccess?: string;
  urlError?: string;
  additionalData?: string;
  accuracyPaymentPercent?: number;
  /** FIAT-mode: amount in fiat. */
  amountFiat?: string;
  /** FIAT-mode: fiat currency code. */
  currency?: string;
  /** FIAT-mode: rate source, e.g. `"binance"`, `"any"`. */
  courseSource?: string;
  /** FIAT-mode: restrict which coins the customer may pick. */
  assets?: AssetsPolicy;
  /** CRYPTO-mode: amount in crypto. */
  amountCrypto?: string;
  /** CRYPTO-mode: fix the exact coin+network. */
  asset?: Asset;
}

export interface CoinOption {
  chainFamily: ChainFamily;
  coin: string;
  network: Chain;
  contract?: string;
}

export interface PayIn {
  type: string;
  uuid: string;
  orderId: string;
  userId?: string;
  status: string;
  mode?: PayInMode;
  amountCrypto?: string;
  amountFiat?: string;
  currency?: string;
  paymentCoin?: string;
  paymentNetwork?: Chain;
  toAddress?: string;
  coins?: CoinOption[];
  paymentLink?: string;
  urlCallback?: string;
  urlSuccess?: string;
  urlError?: string;
  additionalData?: string;
  canCancel?: boolean;
  expiredAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface PayInHistoryResponse {
  items: PayIn[];
  meta: HistoryMeta;
}

export interface SelectAssetRequest {
  uuid: string;
  coin: string;
  network: Chain;
  /**
   * Pin the order's transit deposit wallet to the given project master wallet;
   * see {@link CreatePayInRequest.masterWalletAddress}. A value here overrides
   * one supplied at order create.
   */
  masterWalletAddress?: string;
}

/** Incoming-payment (invoice) endpoints. */
export class PayInsService extends BaseService {
  /** Open a new pay-in order. */
  create(req: CreatePayInRequest, opts?: RequestOptions): Promise<PayIn> {
    return this.call('/v1/payments/order/create', req, opts);
  }

  /** Commit the customer's coin/network choice on a `waiting_asset_select` order. */
  selectAsset(req: SelectAssetRequest, opts?: RequestOptions): Promise<PayIn> {
    return this.call('/v1/payments/asset/select', req, opts);
  }

  /** Revert a pending order to `waiting_asset_select` (H2H only). */
  resetAsset(uuid: string, opts?: RequestOptions): Promise<PayIn> {
    return this.call('/v1/payments/asset/reset', { uuid }, opts);
  }

  /** Cancel an open order. */
  cancel(uuid: string, opts?: RequestOptions): Promise<PayIn> {
    return this.call('/v1/payments/order/cancel', { uuid }, opts);
  }

  /** Fetch the current state of one pay-in by uuid. */
  info(uuid: string, opts?: RequestOptions): Promise<PayIn> {
    return this.call('/v1/payments/order/info', { uuid }, opts);
  }

  /** Paged list of pay-ins. */
  history(query: HistoryQuery = {}, opts?: RequestOptions): Promise<PayInHistoryResponse> {
    return this.call('/v1/payments/history', query, opts);
  }

  /** Poll `info` until the pay-in reaches a terminal state (or timeout). */
  waitFor(uuid: string, opts: PollOptions = {}): Promise<PayIn> {
    return waitForTerminal(
      (signal) => this.info(uuid, { signal }),
      (p) => isPayInTerminal(p.status),
      opts,
    );
  }
}

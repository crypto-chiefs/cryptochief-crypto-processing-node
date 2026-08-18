import type { RequestOptions } from '../client';
import { BaseService } from './base';

export interface CreditsBalance {
  /** Current balance in credits (10,000,000 credits = 1 USD). Negative when in postpaid debt. */
  creditsBalance: number;
  /** Pre-formatted USD equivalent with 2 decimals. Can be negative, e.g. `"-1.52"`. */
  usdBalance: string;
  /** Whether the project bills postpaid (debt allowed up to `debtLimitCredits`). */
  isPostpaid: boolean;
  /** Effective debt limit in credits (postpaid only; `0` for prepaid). */
  debtLimitCredits: number;
  /** Whether gas-paying operations (e.g. `/v1/transaction/execute`) would pass the billing gate. */
  canExecuteGasOperations: boolean;
  /** Minimum credits required for gas-paying operations. */
  gasOpsMinCredits: number;
  /** Server time of the snapshot, RFC 3339. */
  timestamp: string;
}

export interface CreditsTopupParams {
  /** Positive decimal amount to top up, USD-pegged, max `100000` (e.g. `"50"`). */
  amount: string;
  /** Settlement stablecoin: `"USDT"` or `"USDC"`. */
  currency: string;
  /** Absolute http(s) URL the payer's browser is redirected to after a successful payment. */
  urlSuccess?: string;
  /** Absolute http(s) URL the payer's browser is redirected to after a failed payment. */
  urlError?: string;
}

export interface CreditsTopup {
  /** Billing invoice id. */
  invoiceId: number;
  /** Hosted payment page URL (QR code, network selection, live status). */
  paymentLink: string;
  /** Echo of the requested amount. */
  amount: string;
  /** Echo of the requested currency. */
  currency: string;
  /** Invoice status; `"pending"` on creation. */
  status: string;
  /** Processing order uuid, once assigned. */
  orderUuid?: string;
  /** Invoice expiry, unix seconds. */
  expiredAt?: number;
}

/**
 * Billing credits. Both endpoints are billing-exempt (free of charge) - the
 * balance check answers even at zero or negative balance, so integrations can
 * poll it without spending a paid call. Rate-limited to 60 req/min per project.
 */
export class CreditsService extends BaseService {
  /** Current credits balance and whether gas-paying operations would pass the gate. */
  balance(opts?: RequestOptions): Promise<CreditsBalance> {
    return this.call('/v1/credits/balance', {}, opts);
  }

  /**
   * Create a credits top-up invoice and get a hosted payment link. Unset
   * optional redirect URLs are omitted from the signed body, not sent as `""`.
   */
  topup(params: CreditsTopupParams, opts?: RequestOptions): Promise<CreditsTopup> {
    return this.call('/v1/credits/topup', params, opts);
  }
}

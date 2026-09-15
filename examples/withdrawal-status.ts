/**
 * withdrawal-status - list recent withdrawals, then follow one until it is final.
 *
 *   MERCHANT_ID=... API_KEY=... [WITHDRAWAL_UUID=...] npx tsx examples/withdrawal-status.ts
 *
 * Withdrawals are started from the dashboard; the API only reads them.
 */
import {
  CryptoChiefClient,
  PollTimeoutError,
  WithdrawalStatus,
  isWithdrawalTerminal,
  waitForTerminal,
  type Withdrawal,
} from '../src/index';

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`set ${k} in the environment`);
  return v;
};

const client = new CryptoChiefClient({ merchantId: need('MERCHANT_ID'), apiKey: need('API_KEY') });

const progress = (w: Withdrawal): string =>
  `confirmations=${w.confirmations ?? '-'}/${w.requiredConfirmations ?? '-'}`;

const { items, meta } = await client.withdrawals.history({ page: 1, pageSize: 10 });
console.log(`withdrawals: ${meta.total}`);
for (const w of items) {
  console.log(`  ${w.uuid} ${w.status.padEnd(16)} ${w.amount} ${w.coin ?? ''} ${progress(w)}`);
}

const uuid = process.env.WITHDRAWAL_UUID;
if (uuid) {
  // `completed` waits for the network's finality depth (up to ~60 min on BITCOIN_CASH_MAINNET).
  try {
    const final = await waitForTerminal(
      async (signal) => {
        const w = await client.withdrawals.info(uuid, { signal });
        if (w.status === WithdrawalStatus.ConfirmCheck) console.log(`confirm_check: ${progress(w)}`);
        return w;
      },
      (w) => isWithdrawalTerminal(w.status),
      { intervalMs: 5000, timeoutMs: 90 * 60_000 },
    );

    if (final.status === WithdrawalStatus.Completed) {
      console.log(`completed: tx=${final.txHash} ${progress(final)} at ${final.completedAt}`);
    } else {
      // failed.
      console.log(`${final.status}: ${final.errorReason ?? '-'}`);
    }
  } catch (err) {
    if (!(err instanceof PollTimeoutError)) throw err;
    // Not a failure: the withdrawal is still in progress.
    const last = err.lastState as Withdrawal | undefined;
    console.log(`still ${last?.status ?? '-'}${last ? ` ${progress(last)}` : ''}`);
  }
}

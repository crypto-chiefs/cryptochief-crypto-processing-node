/**
 * payout - single payout end-to-end: estimate -> execute -> wait for terminal.
 *
 *   MERCHANT_ID=... API_KEY=... TO_ADDRESS=0x... npx tsx examples/payout.ts
 *
 * Set DRY_RUN=1 to stop after the estimate without moving funds.
 */
import { CryptoChiefClient, Chain, ApiError, ErrorCode } from '../src/index';

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`set ${k} in the environment`);
  return v;
};

const client = new CryptoChiefClient({ merchantId: need('MERCHANT_ID'), apiKey: need('API_KEY') });
const toAddress = need('TO_ADDRESS');
const base = { network: Chain.EthSepolia, coin: 'ETH', amount: '0.0001', toAddress } as const;

const est = await client.payouts.estimate(base);
console.log(`estimate: to_receive=${est.amountToReceive} sources=${est.sources?.length ?? 0} fee~$${est.feeInfo?.estimatedFiat ?? '?'}`);

if (process.env.DRY_RUN) {
  console.log('DRY_RUN=1 -> stopping after estimate');
  process.exit(0);
}

try {
  const exec = await client.payouts.execute({
    ...base,
    orderId: `demo-${Date.now()}`, // idempotency key - safe to retry
    userId: 'demo-user',
    urlCallback: 'https://example.com/webhooks/payout',
  });
  console.log(`queued: uuid=${exec.uuid} order_id=${exec.orderId}`);

  const final = await client.payouts.waitFor(exec.uuid, { intervalMs: 4000, timeoutMs: 4 * 60_000 });
  console.log(`terminal: status=${final.status} txid=${final.txid ?? '-'}`);
} catch (err) {
  if (err instanceof ApiError && err.code === ErrorCode.InsufficientFunds) {
    console.error('not enough balance - top up and retry');
  }
  throw err;
}

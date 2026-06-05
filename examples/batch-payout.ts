/**
 * batch-payout - mass payout (up to 50 recipients) with concurrent per-item
 * polling once the batch is accepted.
 *
 *   MERCHANT_ID=... API_KEY=... npx tsx examples/batch-payout.ts
 */
import { CryptoChiefClient, Chain, type ExecutePayoutRequest } from '../src/index';

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`set ${k} in the environment`);
  return v;
};

const client = new CryptoChiefClient({ merchantId: need('MERCHANT_ID'), apiKey: need('API_KEY') });

const recipients = ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222'];
const items: ExecutePayoutRequest[] = recipients.map((toAddress, i) => ({
  orderId: `batch-${Date.now()}-${i}`,
  userId: `user-${i}`,
  network: Chain.EthSepolia,
  coin: 'ETH',
  amount: '0.0001',
  toAddress,
  urlCallback: 'https://example.com/webhooks/payout',
}));

const res = await client.payouts.batchExecute({ items, urlCallback: 'https://example.com/webhooks/payout' });
console.log(`batch ${res.batchUuid ?? '-'}: accepted=${res.accepted} rejected=${res.rejected}`);

const accepted = res.items.filter((it) => it.uuid);
const finals = await Promise.all(
  accepted.map((it) => client.payouts.waitFor(it.uuid!, { intervalMs: 4000, timeoutMs: 4 * 60_000 })),
);
for (const f of finals) console.log(`  ${f.orderId}: ${f.status} ${f.txid ?? ''}`);

for (const it of res.items.filter((x) => x.error)) {
  console.log(`  rejected ${it.orderId}: ${it.error}`);
}

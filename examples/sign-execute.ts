/**
 * sign-execute - two-phase native transfer: sign (no broadcast) -> execute.
 *
 *   MERCHANT_ID=... API_KEY=... FROM=0x... TO=0x... npx tsx examples/sign-execute.ts
 */
import { CryptoChiefClient, Chain, TxType, humanToBase } from '../src/index';

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`set ${k} in the environment`);
  return v;
};

const client = new CryptoChiefClient({ merchantId: need('MERCHANT_ID'), apiKey: need('API_KEY') });

const wei = humanToBase('0.0001', 18); // base units (wei)
const signed = await client.transactions.sign({
  network: Chain.EthSepolia,
  fromAddress: need('FROM'),
  type: TxType.Native,
  toAddress: need('TO'),
  value: wei.toString(),
  urlCallback: 'https://example.com/webhooks/transaction',
});
console.log(`signed: uuid=${signed.uuid} tx_hash=${signed.txHash} expires_at=${signed.expiresAt}`);

// Broadcast before the signature TTL elapses.
const info = await client.transactions.execute({ uuid: signed.uuid });
console.log(`broadcasted: status=${info.status}`);

const final = await client.transactions.waitFor(signed.uuid, { intervalMs: 4000 });
console.log(`terminal: status=${final.status} tx_hash=${final.txHash ?? '-'}`);

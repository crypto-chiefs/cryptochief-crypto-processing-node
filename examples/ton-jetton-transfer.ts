/**
 * ton-jetton-transfer - transfer a Jetton (e.g. USDT on TON) in one call. The
 * SDK builds the TEP-74 body, resolves the sender's Jetton wallet via RPC, and
 * picks the gas budget automatically. No BoC encoding in your code.
 *
 *   MERCHANT_ID=... API_KEY=... FROM=EQ... TO=EQ... npx tsx examples/ton-jetton-transfer.ts
 */
import { CryptoChiefClient, Chain, humanToBase } from '../src/index';

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`set ${k} in the environment`);
  return v;
};

const client = new CryptoChiefClient({ merchantId: need('MERCHANT_ID'), apiKey: need('API_KEY') });

const amount = humanToBase('0.5', 6); // USDT Jetton has 6 decimals
const signed = await client.transactions.jettonTransfer({
  network: Chain.TonMainnet,
  fromAddress: need('FROM'),
  jettonMaster: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs', // USDT master
  recipient: need('TO'),
  amount,
  memo: 'Order #4242', // wallets display this as the transfer comment
  // attachedTon / forwardTonAmount auto-picked when omitted
  urlCallback: 'https://example.com/webhooks/transaction',
});
console.log(`signed Jetton transfer: uuid=${signed.uuid} tx_hash=${signed.txHash}`);
// await client.transactions.execute({ uuid: signed.uuid });

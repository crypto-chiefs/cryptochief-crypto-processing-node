/**
 * trc20-transfer - TRC-20 (USDT on TRON) transfer using the erc20Transfer
 * one-liner with base58 TRON addresses (the same ABI encoder handles TRON).
 *
 *   MERCHANT_ID=... API_KEY=... FROM=T... TO=T... npx tsx examples/trc20-transfer.ts
 */
import { CryptoChiefClient, Chain, humanToBase } from '../src/index';

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`set ${k} in the environment`);
  return v;
};

const client = new CryptoChiefClient({ merchantId: need('MERCHANT_ID'), apiKey: need('API_KEY') });

const amount = humanToBase('12.5', 6); // USDT has 6 decimals
const signed = await client.transactions.erc20Transfer({
  network: Chain.TronMainnet,
  fromAddress: need('FROM'),
  tokenContract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', // USDT TRC-20 (base58)
  recipient: need('TO'),
  amount,
  urlCallback: 'https://example.com/webhooks/transaction',
});
console.log(`signed TRC-20 transfer: uuid=${signed.uuid} tx_hash=${signed.txHash}`);
// await client.transactions.execute({ uuid: signed.uuid });

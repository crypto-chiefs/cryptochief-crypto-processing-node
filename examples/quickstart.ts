/**
 * quickstart - list the project's enabled assets and read a wallet balance.
 *
 *   MERCHANT_ID=... API_KEY=... ADDRESS=0x... npx tsx examples/quickstart.ts
 *
 * In your own app, import from the published package instead of '../src':
 *   import { CryptoChiefClient, Chain } from '@cryptochiefs/cryptochief-crypto-processing-node';
 */
import { CryptoChiefClient, Chain } from '../src/index';

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`set ${k} in the environment`);
  return v;
};

const client = new CryptoChiefClient({ merchantId: need('MERCHANT_ID'), apiKey: need('API_KEY') });

const { items } = await client.blockchain.contractsAvailable(Chain.EthSepolia);
console.log(`enabled assets on ETH Sepolia: ${items.length}`);
for (const a of items.slice(0, 5)) {
  console.log(`  ${a.coin.padEnd(6)} type=${a.type ?? 'native'} decimals=${a.decimals} ${a.contract ?? ''}`);
}

const address = process.env.ADDRESS;
if (address) {
  const rows = await client.blockchain.walletBalance(Chain.EthSepolia, [address]);
  for (const r of rows) {
    console.log(`balance ${r.address}: ${r.humanValue} (${r.value} base units)`);
  }
}

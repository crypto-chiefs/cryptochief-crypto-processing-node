/**
 * uniswap-swap - a Uniswap V2 swap via one-line ABI encoding (no hand-built
 * calldata). Signs the contract call; broadcast with transactions.execute.
 *
 *   MERCHANT_ID=... API_KEY=... FROM=0x... TOKEN_IN=0x... TOKEN_OUT=0x... \
 *     npx tsx examples/uniswap-swap.ts
 */
import { CryptoChiefClient, Chain, humanToBase } from '../src/index';

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`set ${k} in the environment`);
  return v;
};

const client = new CryptoChiefClient({ merchantId: need('MERCHANT_ID'), apiKey: need('API_KEY') });

const from = need('FROM');
const amountIn = humanToBase('0.01', 18);
const amountOutMin = 0n;
const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
const path = [need('TOKEN_IN'), need('TOKEN_OUT')];

const signed = await client.transactions.signEvmCall({
  network: Chain.EthMainnet,
  fromAddress: from,
  contract: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', // Uniswap V2 router
  method: 'swapExactTokensForTokens(uint256,uint256,address[],address,uint256)',
  args: [amountIn, amountOutMin, path, from, deadline],
  urlCallback: 'https://example.com/webhooks/transaction',
});
console.log(`signed swap: uuid=${signed.uuid} tx_hash=${signed.txHash}`);
// await client.transactions.execute({ uuid: signed.uuid });

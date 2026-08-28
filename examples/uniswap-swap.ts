/**
 * uniswap-swap - a Uniswap V2 swap via one-line ABI encoding (no hand-built
 * calldata). Two transactions, not one: the router pulls TOKEN_IN out of your
 * wallet with `transferFrom`, so it needs an ERC-20 allowance first - approve,
 * let that confirm, then swap.
 *
 *   MERCHANT_ID=... API_KEY=... FROM=0x... TOKEN_IN=0x... TOKEN_OUT=0x... \
 *     MIN_OUT=1234.5 npx tsx examples/uniswap-swap.ts
 *
 * Set BROADCAST=1 to actually send both transactions; without it the example
 * stops after signing the approve, since the swap must not be signed before the
 * approve is mined.
 */
import { CryptoChiefClient, Chain, TxStatus, humanToBase } from '../src/index';

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`set ${k} in the environment`);
  return v;
};

const client = new CryptoChiefClient({ merchantId: need('MERCHANT_ID'), apiKey: need('API_KEY') });

const router = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'; // Uniswap V2 router
const from = need('FROM');
const tokenIn = need('TOKEN_IN');
const amountIn = humanToBase('0.01', 18);
// Slippage floor. Required on purpose: `amountOutMin = 0` accepts ANY output,
// which hands the whole trade to the first sandwich bot that sees it. MIN_OUT=0
// is an explicit opt-out, only sane on a private fork.
const amountOutMin = humanToBase(need('MIN_OUT'), 18); // 18 = TOKEN_OUT decimals (USDC/USDT are 6)
if (amountOutMin === 0n) console.warn('MIN_OUT=0 -> no slippage protection on this swap');
const path = [tokenIn, need('TOKEN_OUT')];

// Allowance first, or the router's `transferFrom` reverts and the swap burns
// gas for nothing. Approving exactly `amountIn` leaves no standing allowance
// behind - and keeps re-runs working on tokens (USDT) that refuse a non-zero
// -> non-zero approve.
const approve = await client.transactions.signEvmCall({
  network: Chain.EthMainnet,
  fromAddress: from,
  contract: tokenIn,
  method: 'approve(address,uint256)',
  args: [router, amountIn],
  urlCallback: 'https://example.com/webhooks/transaction',
});
console.log(`signed approve: uuid=${approve.uuid} tx_hash=${approve.txHash}`);

if (!process.env.BROADCAST) {
  console.log('BROADCAST unset -> stopping after the approve signature');
  process.exit(0);
}

await client.transactions.execute({ uuid: approve.uuid });
const approved = await client.transactions.waitFor(approve.uuid, { intervalMs: 4000 });
if (approved.status !== TxStatus.Confirmed) {
  throw new Error(`approve did not confirm: status=${approved.status}${approved.error ? ` (${approved.error})` : ''}`);
}
console.log(`approve confirmed: tx_hash=${approved.txHash ?? '-'}`);

// Signed only now: the nonce comes from chain state, so signing the swap up
// front would reserve the same nonce as the approve. The deadline is likewise
// measured from here, not from before the wait.
const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
const signed = await client.transactions.signEvmCall({
  network: Chain.EthMainnet,
  fromAddress: from,
  contract: router,
  method: 'swapExactTokensForTokens(uint256,uint256,address[],address,uint256)',
  args: [amountIn, amountOutMin, path, from, deadline],
  urlCallback: 'https://example.com/webhooks/transaction',
});
console.log(`signed swap: uuid=${signed.uuid} tx_hash=${signed.txHash}`);

await client.transactions.execute({ uuid: signed.uuid });
const final = await client.transactions.waitFor(signed.uuid, { intervalMs: 4000 });
console.log(`terminal: status=${final.status} tx_hash=${final.txHash ?? '-'}`);

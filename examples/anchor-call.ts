/**
 * anchor-call - invoke a Solana Anchor program. The SDK builds the 8-byte
 * discriminator + Borsh-encoded args; you supply the account metas (Solana has
 * no on-chain ABI to derive them from).
 *
 *   MERCHANT_ID=... API_KEY=... FROM=... PROGRAM=... DATA_ACCT=... \
 *     npx tsx examples/anchor-call.ts
 */
import { CryptoChiefClient, Chain, borshU64, borshString } from '../src/index';

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`set ${k} in the environment`);
  return v;
};

const client = new CryptoChiefClient({ merchantId: need('MERCHANT_ID'), apiKey: need('API_KEY') });

const from = need('FROM');
const signed = await client.transactions.signAnchorCall({
  network: Chain.SolanaDevnet,
  fromAddress: from,
  program: need('PROGRAM'),
  method: 'initialize',
  args: [borshU64(1_000_000n), borshString('hello')],
  accounts: [
    { pubkey: from, isSigner: true, isWritable: true },
    { pubkey: need('DATA_ACCT'), isSigner: false, isWritable: true },
    { pubkey: '11111111111111111111111111111111', isSigner: false, isWritable: false }, // system program
  ],
  urlCallback: 'https://example.com/webhooks/transaction',
});
console.log(`signed Anchor call: uuid=${signed.uuid}`);
// await client.transactions.execute({ uuid: signed.uuid });

/**
 * wallet-generate - generate a project wallet and decrypt its private key
 * locally with your RSA key.
 *
 * One-time setup (upload rsa_public.pem in the dashboard -> Project Settings -> RSA Key):
 *   openssl genrsa -out rsa_private.pem 2048
 *   openssl rsa -in rsa_private.pem -pubout -out rsa_public.pem
 *
 *   MERCHANT_ID=... API_KEY=... RSA_PRIVATE_KEY_PATH=./rsa_private.pem \
 *     npx tsx examples/wallet-generate.ts
 */
import { readFileSync } from 'node:fs';
import { CryptoChiefClient, ChainFamily, WalletType } from '../src/index';

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`set ${k} in the environment`);
  return v;
};

const client = new CryptoChiefClient({
  merchantId: need('MERCHANT_ID'),
  apiKey: need('API_KEY'),
  rsaPrivateKey: readFileSync(need('RSA_PRIVATE_KEY_PATH'), 'utf8'),
});

const wallet = await client.wallets.generate({
  walletType: WalletType.Master,
  chainFamily: ChainFamily.Evm,
  // Optional human-readable name, up to 255 characters. Works for every wallet
  // type; omit it and nothing is sent.
  label: 'Treasury EU',
});
console.log(`generated wallet: ${wallet.address} (${wallet.label ?? 'unnamed'})`);

// The name is not fixed at creation - set it later on any wallet type, or pass
// '' to take it away. What comes back is the wallet as it now stands, with
// `label` either the new name or null.
const renamed = await client.wallets.setLabel(wallet.address, 'Treasury EU - cold');
console.log(`renamed to: ${renamed.label}`);

if (wallet.privateKeyEncrypted) {
  const privHex = client.wallets.decryptPrivateKey(wallet.privateKeyEncrypted);
  console.log(`decrypted private key (keep safe!): ${privHex.slice(0, 6)}...${privHex.slice(-4)}`);
}

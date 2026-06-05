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
});
console.log(`generated wallet: ${wallet.address}`);

if (wallet.privateKeyEncrypted) {
  const privHex = client.wallets.decryptPrivateKey(wallet.privateKeyEncrypted);
  console.log(`decrypted private key (keep safe!): ${privHex.slice(0, 6)}...${privHex.slice(-4)}`);
}

import { describe, it, expect } from 'vitest';
import { constants, generateKeyPairSync, publicEncrypt } from 'node:crypto';
import { CryptoChiefClient } from '../src/client';
import { RsaKeyNotConfiguredError } from '../src/rsa';

function encryptForProject(publicKey: import('node:crypto').KeyObject, plaintext: string): string {
  return publicEncrypt(
    { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(plaintext, 'utf8'),
  ).toString('base64');
}

describe('RSA wallet private-key decryption', () => {
  it('decrypts an RSA-OAEP / SHA-256 payload (PKCS#8 key)', () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const secret = '0xabc123deadbeefcafef00d';
    const ciphertext = encryptForProject(publicKey, secret);
    const client = new CryptoChiefClient({
      merchantId: 'M',
      apiKey: 'K',
      rsaPrivateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    });
    expect(client.wallets.decryptPrivateKey(ciphertext)).toBe(secret);
  });

  it('accepts a PKCS#1 PEM key', () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const ciphertext = encryptForProject(publicKey, 'hello-world');
    const client = new CryptoChiefClient({
      merchantId: 'M',
      apiKey: 'K',
      rsaPrivateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }) as string,
    });
    expect(client.wallets.decryptPrivateKey(ciphertext)).toBe('hello-world');
  });

  it('throws when no RSA key is configured', () => {
    const client = new CryptoChiefClient({ merchantId: 'M', apiKey: 'K' });
    expect(() => client.wallets.decryptPrivateKey('AA==')).toThrow(RsaKeyNotConfiguredError);
  });
});

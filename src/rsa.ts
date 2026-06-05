import { constants, createPrivateKey, privateDecrypt, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CryptoChiefError } from './errors';

/**
 * Local RSA decryption of generated wallets' private keys.
 *
 * When the API generates a wallet it returns the private key encrypted with the
 * RSA public key uploaded to your project (Project Settings -> RSA Key). The
 * scheme is RSA-OAEP / SHA-256 over base64-encoded ciphertext. Configure the
 * matching private key on the client to decrypt it locally.
 */

/** Thrown by {@link CryptoChiefClient.rsaDecrypt} when no RSA key was configured. */
export class RsaKeyNotConfiguredError extends CryptoChiefError {
  constructor() {
    super('cryptochief: RSA private key not configured - pass rsaPrivateKey to the client');
    this.name = 'RsaKeyNotConfiguredError';
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Parse a PEM-encoded RSA private key (PKCS#1 `BEGIN RSA PRIVATE KEY` or PKCS#8
 * `BEGIN PRIVATE KEY`) into a Node `KeyObject`.
 */
export function loadRsaPrivateKeyPem(pem: string | Buffer): KeyObject {
  try {
    return createPrivateKey(pem);
  } catch (err) {
    throw new CryptoChiefError(`cryptochief: RSA key: ${message(err)}`);
  }
}

/** Read and parse a PEM-encoded RSA private key from disk. */
export function loadRsaPrivateKeyFile(path: string): KeyObject {
  let data: Buffer;
  try {
    data = readFileSync(path);
  } catch (err) {
    throw new CryptoChiefError(`cryptochief: read RSA key ${JSON.stringify(path)}: ${message(err)}`);
  }
  return loadRsaPrivateKeyPem(data);
}

/**
 * Decrypt a single base64-encoded RSA-OAEP / SHA-256 payload - the exact
 * encoding the API uses for `private_key_encrypted`. Returns the wallet's raw
 * private key in the chain's native hex form.
 */
export function decryptRsaOaep(key: KeyObject, base64Ciphertext: string): string {
  const ct = Buffer.from(base64Ciphertext, 'base64');
  let pt: Buffer;
  try {
    pt = privateDecrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, ct);
  } catch (err) {
    throw new CryptoChiefError(`cryptochief: RSA decrypt: ${message(err)}`);
  }
  return pt.toString('utf8');
}

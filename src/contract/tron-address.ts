import { createHash } from 'node:crypto';
import { CryptoChiefError } from '../errors';
import { base58Decode, base58Encode } from './base58';

/** Double SHA-256, as used by Base58Check. */
function sha256d(b: Uint8Array): Uint8Array {
  const h1 = createHash('sha256').update(b).digest();
  return new Uint8Array(createHash('sha256').update(h1).digest());
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Convert a TRON base58 address (`T...`) to its 0x41-prefixed 21-byte hex form,
 * validating the Base58Check (double-SHA-256) checksum.
 *
 * ```ts
 * tronToHex('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
 * // '0x41a614f803b6fd780986a42c78ec9c7f77e6ded13c'
 * ```
 */
export function tronToHex(base58Addr: string): string {
  const decoded = base58Decode(base58Addr.trim());
  if (decoded.length !== 25) {
    throw new CryptoChiefError(`cryptochief/tron: decoded length ${decoded.length}, want 25`);
  }
  const payload = decoded.subarray(0, 21);
  const sum = decoded.subarray(21);
  if (payload[0] !== 0x41) {
    throw new CryptoChiefError(`cryptochief/tron: leading byte 0x${payload[0]!.toString(16)}, want 0x41`);
  }
  const want = sha256d(payload).subarray(0, 4);
  if (!equalBytes(sum, want)) throw new CryptoChiefError('cryptochief/tron: checksum mismatch');
  return '0x' + bytesToHex(payload);
}

/**
 * Convert an EVM-style 20-byte hex address (or a 0x41-prefixed 21-byte TRON
 * hex) to its base58 form. A 20-byte input is prefixed with `0x41` automatically.
 */
export function hexToTron(hexAddr: string): string {
  let s = hexAddr.trim().replace(/^0x/i, '');
  const raw = hexToBytes(s);
  let payload: Uint8Array;
  if (raw.length === 20) {
    payload = new Uint8Array(21);
    payload[0] = 0x41;
    payload.set(raw, 1);
  } else if (raw.length === 21) {
    if (raw[0] !== 0x41) {
      throw new CryptoChiefError(
        `cryptochief/tron: 21-byte input must start with 0x41, got 0x${raw[0]!.toString(16)}`,
      );
    }
    payload = raw;
  } else {
    throw new CryptoChiefError(`cryptochief/tron: want 20- or 21-byte hex address, got ${raw.length} bytes`);
  }
  const sum = sha256d(payload).subarray(0, 4);
  const full = new Uint8Array(payload.length + 4);
  full.set(payload);
  full.set(sum, payload.length);
  return base58Encode(full);
}

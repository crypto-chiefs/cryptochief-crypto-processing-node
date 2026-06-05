import { CryptoChiefError } from '../errors';

/**
 * Base58 (Bitcoin/Tron/Solana alphabet). Shared by the TRON address codec and
 * Solana pubkey decoding. Pure `bigint` arithmetic - no external dependency.
 */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const DECODE_MAP: Int8Array = (() => {
  const m = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) m[ALPHABET.charCodeAt(i)] = i;
  return m;
})();

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  let num = 0n;
  for (const b of bytes) num = num * 256n + BigInt(b);

  let out = '';
  while (num > 0n) {
    const rem = Number(num % 58n);
    num /= 58n;
    out = ALPHABET[rem] + out;
  }
  return ALPHABET[0]!.repeat(zeros) + out;
}

export function base58Decode(s: string): Uint8Array {
  if (s === '') throw new CryptoChiefError('cryptochief: base58: empty input');
  let zeros = 0;
  while (zeros < s.length && s[zeros] === ALPHABET[0]) zeros++;

  let num = 0n;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? DECODE_MAP[c]! : -1;
    if (v < 0) throw new CryptoChiefError(`cryptochief: base58: invalid char ${JSON.stringify(s[i])}`);
    num = num * 58n + BigInt(v);
  }

  const body: number[] = [];
  while (num > 0n) {
    body.unshift(Number(num % 256n));
    num /= 256n;
  }
  const out = new Uint8Array(zeros + body.length);
  out.set(body, zeros);
  return out;
}

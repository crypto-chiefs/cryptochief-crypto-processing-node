import { createHash } from 'node:crypto';
import { CryptoChiefError } from '../errors';
import { base58Decode } from './base58';

/**
 * Borsh encoding + Anchor instruction building for Solana.
 *
 * Anchor instruction data is `[8-byte discriminator][Borsh-encoded args]`.
 * Borsh has no on-wire type tags, so the caller must describe each argument's
 * type explicitly - the {@link BorshValue} constructors below force that.
 */

class BorshError extends CryptoChiefError {
  constructor(message: string) {
    super(`cryptochief/anchor: ${message}`);
    this.name = 'BorshError';
  }
}

/** A value paired with its explicit Borsh type, ready to encode. */
export class BorshValue {
  constructor(private readonly encoder: () => Uint8Array) {}
  encode(): Uint8Array {
    return this.encoder();
  }
}

function leBytes(value: bigint, width: number): Uint8Array {
  const out = new Uint8Array(width);
  let v = value;
  for (let i = 0; i < width; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Unsigned little-endian integers. */
export const borshU8 = (n: number): BorshValue => new BorshValue(() => leBytes(BigInt.asUintN(8, BigInt(n)), 1));
export const borshU16 = (n: number): BorshValue => new BorshValue(() => leBytes(BigInt.asUintN(16, BigInt(n)), 2));
export const borshU32 = (n: number): BorshValue => new BorshValue(() => leBytes(BigInt.asUintN(32, BigInt(n)), 4));
export const borshU64 = (n: bigint | number): BorshValue =>
  new BorshValue(() => leBytes(BigInt.asUintN(64, BigInt(n)), 8));

/** Signed little-endian integers (two's complement). */
export const borshI8 = borshU8;
export const borshI16 = borshU16;
export const borshI32 = borshU32;
export const borshI64 = borshU64;

/** 128-bit unsigned little-endian. Must be non-negative and < 2^128. */
export const borshU128 = (n: bigint): BorshValue =>
  new BorshValue(() => {
    if (n < 0n) throw new BorshError('u128 negative');
    if (n >= 1n << 128n) throw new BorshError('u128 overflow');
    return leBytes(n, 16);
  });

/** 1-byte boolean (0x00 / 0x01). */
export const borshBool = (b: boolean): BorshValue => new BorshValue(() => new Uint8Array([b ? 1 : 0]));

/** UTF-8 string: 4-byte LE length prefix + bytes. */
export const borshString = (s: string): BorshValue =>
  new BorshValue(() => {
    const bytes = new TextEncoder().encode(s);
    return concat([leBytes(BigInt(bytes.length), 4), bytes]);
  });

/** Raw byte slice: 4-byte LE length prefix + bytes (same wire form as a string). */
export const borshBytes = (b: Uint8Array): BorshValue =>
  new BorshValue(() => concat([leBytes(BigInt(b.length), 4), b]));

/** Fixed-length bytes with NO length prefix (Anchor's `[u8; N]`). */
export const borshFixedBytes = (b: Uint8Array, n: number): BorshValue =>
  new BorshValue(() => {
    if (b.length !== n) throw new BorshError(`BorshFixedBytes: expected ${n} bytes, got ${b.length}`);
    return b.slice(0, n);
  });

/** A Solana 32-byte pubkey (base58 string or raw 32 bytes). */
export const borshPubkey = (pk: string | Uint8Array): BorshValue =>
  new BorshValue(() => decodeSolanaPubkey(pk));

/** Nullable value: `null` -> 0x00; otherwise 0x01 + inner encoding. */
export const borshOption = (inner: BorshValue | null | undefined): BorshValue =>
  new BorshValue(() => (inner ? concat([new Uint8Array([1]), inner.encode()]) : new Uint8Array([0])));

/** Homogeneous `Vec<T>`: 4-byte LE length + elements. */
export const borshVec = (items: BorshValue[]): BorshValue =>
  new BorshValue(() => concat([leBytes(BigInt(items.length), 4), ...items.map((it) => it.encode())]));

/** Heterogeneous struct/tuple: fields in order, no length prefix. */
export const borshStruct = (...fields: BorshValue[]): BorshValue =>
  new BorshValue(() => concat(fields.map((f) => f.encode())));

/** The 8-byte Anchor instruction discriminator: sha256("global:<method>")[:8]. */
export function anchorDiscriminator(method: string): Uint8Array {
  const hash = createHash('sha256').update(`global:${method}`).digest();
  return new Uint8Array(hash.subarray(0, 8));
}

/** Raw Anchor instruction data: 8-byte discriminator + Borsh-encoded args. */
export function encodeAnchorInstruction(method: string, ...args: BorshValue[]): Uint8Array {
  const parts = [anchorDiscriminator(method)];
  args.forEach((a, i) => {
    try {
      parts.push(a.encode());
    } catch (err) {
      throw err instanceof CryptoChiefError ? new BorshError(`arg ${i}: ${err.message}`) : err;
    }
  });
  return concat(parts);
}

/** Decode a Solana pubkey (base58 string or raw 32 bytes) to its 32-byte form. */
export function decodeSolanaPubkey(pk: string | Uint8Array): Uint8Array {
  if (pk instanceof Uint8Array) {
    if (pk.length !== 32) throw new BorshError(`solana pubkey: want 32 bytes, got ${pk.length}`);
    return pk;
  }
  const raw = base58Decode(pk);
  if (raw.length !== 32) throw new BorshError(`solana pubkey: decoded length ${raw.length}, want 32`);
  return raw;
}

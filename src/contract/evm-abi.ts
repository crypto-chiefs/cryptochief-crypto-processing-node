import { keccak_256 } from '@noble/hashes/sha3';
import { CryptoChiefError } from '../errors';
import { tronToHex } from './tron-address';

/**
 * Solidity ABI encoder - turns a function signature + argument values into
 * calldata, so callers never hand-encode the `data` field. Shared by EVM and
 * TRON (TRON uses the same ABI).
 *
 * Supported types: `uint<M>` / `int<M>` (M in {8..256}, step 8; bare `uint`/`int`
 * alias to 256), `address` (0x hex, 0x41 TRON hex, or `T...` base58), `bool`,
 * `bytes`, `bytes<N>` (N in 1..32), `string`, and fixed/dynamic arrays `T[]` /
 * `T[N]` of any supported `T`.
 *
 * Argument value forms: integers accept `bigint`, integer `number`, or string
 * (decimal / `0x` hex); `bytes` accept `Uint8Array` or string (raw / `0x` hex);
 * `address`/`string` take strings; arrays take JS arrays of the above.
 */

interface AbiType {
  kind: 'uint' | 'int' | 'address' | 'bool' | 'bytes' | 'string' | 'bytesN' | 'array';
  size: number; // bits for int/uint; byte length for bytesN; element count for fixed arrays (-1 = dynamic)
  element?: AbiType;
}

class EvmAbiError extends CryptoChiefError {
  constructor(message: string) {
    super(`cryptochief/evm: ${message}`);
    this.name = 'EvmAbiError';
  }
}

// -- Signature parsing --------------------------------------------------------

function expandAlias(t: string): string {
  const i = t.lastIndexOf('[');
  if (i > 0) return expandAlias(t.slice(0, i)) + t.slice(i);
  if (t === 'uint') return 'uint256';
  if (t === 'int') return 'int256';
  if (t === 'byte') return 'bytes1';
  return t;
}

function stripParamName(p: string): string {
  p = p.trim();
  const sp = p.indexOf(' ');
  if (sp >= 0) p = p.slice(0, sp).trim();
  return expandAlias(p);
}

/** Canonical signature form keccak hashes against (no spaces, no param names). */
export function canonicalSignature(sig: string): string {
  const open = sig.indexOf('(');
  const close = sig.lastIndexOf(')');
  if (open < 0 || close < 0 || close < open) return sig.replace(/ /g, '');
  const name = sig.slice(0, open).trim();
  const body = sig.slice(open + 1, close).trim();
  if (body === '') return `${name}()`;
  const parts = body.split(',').map(stripParamName);
  return `${name}(${parts.join(',')})`;
}

function parseSignature(sig: string): { name: string; types: string[] } {
  const open = sig.indexOf('(');
  const close = sig.lastIndexOf(')');
  if (open < 0 || close < 0 || close < open) throw new EvmAbiError(`bad signature ${JSON.stringify(sig)}`);
  const name = sig.slice(0, open).trim();
  if (name === '') throw new EvmAbiError('signature missing name');
  const body = sig.slice(open + 1, close).trim();
  if (body === '') return { name, types: [] };
  return { name, types: body.split(',').map(stripParamName) };
}

function parseIntBits(s: string, kind: string): number {
  if (s === '') return 256;
  const bits = Number(s);
  if (!Number.isInteger(bits) || bits <= 0 || bits > 256 || bits % 8 !== 0) {
    throw new EvmAbiError(`invalid ${kind} width ${JSON.stringify(s)}`);
  }
  return bits;
}

function parseType(raw: string): AbiType {
  const t = raw.trim();
  if (t === '') throw new EvmAbiError('empty type');
  if (t.endsWith(']')) {
    const open = t.lastIndexOf('[');
    if (open < 0) throw new EvmAbiError(`malformed type ${JSON.stringify(t)}`);
    const element = parseType(t.slice(0, open));
    const span = t.slice(open + 1, t.length - 1);
    let size = -1;
    if (span !== '') {
      size = Number(span);
      if (!Number.isInteger(size) || size < 0) throw new EvmAbiError(`bad array size in ${JSON.stringify(t)}`);
    }
    return { kind: 'array', size, element };
  }
  if (t.startsWith('uint')) return { kind: 'uint', size: parseIntBits(t.slice(4), 'uint') };
  if (t.startsWith('int')) return { kind: 'int', size: parseIntBits(t.slice(3), 'int') };
  if (t === 'address') return { kind: 'address', size: 0 };
  if (t === 'bool') return { kind: 'bool', size: 0 };
  if (t === 'string') return { kind: 'string', size: 0 };
  if (t === 'bytes') return { kind: 'bytes', size: 0 };
  if (t.startsWith('bytes')) {
    const n = Number(t.slice(5));
    if (!Number.isInteger(n) || n < 1 || n > 32) throw new EvmAbiError(`invalid fixed bytes type ${JSON.stringify(t)}`);
    return { kind: 'bytesN', size: n };
  }
  throw new EvmAbiError(`unsupported type ${JSON.stringify(t)}`);
}

function isDynamic(t: AbiType): boolean {
  if (t.kind === 'bytes' || t.kind === 'string') return true;
  if (t.kind === 'array') return t.size < 0 || isDynamic(t.element!);
  return false;
}

// -- Value coercion -----------------------------------------------------------

function toBigIntValue(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) throw new EvmAbiError(`integer: non-integer number ${v}`);
    return BigInt(v);
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') throw new EvmAbiError('integer: empty string');
    try {
      // BigInt() accepts "0x..." hex and decimal; reject anything else.
      return BigInt(s);
    } catch {
      throw new EvmAbiError(`invalid integer string ${JSON.stringify(v)}`);
    }
  }
  throw new EvmAbiError(`integer: unsupported type ${typeof v}`);
}

function toBigUint(v: unknown, bits: number): bigint {
  const n = toBigIntValue(v);
  if (n < 0n) throw new EvmAbiError(`uint${bits}: negative value ${n}`);
  if (n >= 1n << BigInt(bits)) throw new EvmAbiError(`uint${bits}: value ${n} exceeds max`);
  return n;
}

function toBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^0x/i.test(s)) {
      const hex = s.slice(2);
      if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) throw new EvmAbiError(`bytes: bad hex ${JSON.stringify(v)}`);
      const out = new Uint8Array(hex.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      return out;
    }
    return new TextEncoder().encode(s);
  }
  throw new EvmAbiError(`bytes: unsupported type ${typeof v}`);
}

/** Accept 0x hex, 0x41 TRON hex, or `T...` base58; return the 20-byte address. */
function normalizeEvmAddress(input: unknown): Uint8Array {
  if (typeof input !== 'string') throw new EvmAbiError(`address: want string, got ${typeof input}`);
  let s = input.trim();
  if (s === '') throw new EvmAbiError('address: empty');
  if (s.length >= 30 && (s[0] === 'T' || s[0] === 't') && !/^0x/i.test(s)) {
    const hexAddr = tronToHex(s).replace(/^0x/i, '');
    const raw = hexFixed(hexAddr);
    if (raw.length === 21 && raw[0] === 0x41) return raw.subarray(1);
    if (raw.length === 20) return raw;
    throw new EvmAbiError(`address: unexpected TRON length ${raw.length}`);
  }
  s = s.replace(/^0x/i, '');
  if (s.length === 42 && s.slice(0, 2) === '41') s = s.slice(2); // 0x41-prefixed TRON hex
  if (s.length !== 40) throw new EvmAbiError(`address: want 20 hex bytes, got ${s.length} chars`);
  return hexFixed(s);
}

function hexFixed(hex: string): Uint8Array {
  if (/[^0-9a-fA-F]/.test(hex)) throw new EvmAbiError('address: bad hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// -- Word packing -------------------------------------------------------------

const TWO_256 = 1n << 256n;

function uint256Bytes(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  if (n < 0n) n = TWO_256 + (n % TWO_256); // two's-complement wrap
  let i = 31;
  while (n > 0n && i >= 0) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
    i--;
  }
  return out;
}

function roundUp32(n: number): number {
  const r = n % 32;
  return r === 0 ? n : n + 32 - r;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function encodeDynBytes(b: Uint8Array): Uint8Array {
  const padded = roundUp32(b.length);
  const out = new Uint8Array(32 + padded);
  out.set(uint256Bytes(BigInt(b.length)), 0);
  out.set(b, 32);
  return out;
}

function encodeOne(t: AbiType, v: unknown): Uint8Array {
  switch (t.kind) {
    case 'uint':
      return uint256Bytes(toBigUint(v, t.size));
    case 'int':
      return uint256Bytes(toBigIntValue(v));
    case 'address': {
      const addr = normalizeEvmAddress(v);
      const out = new Uint8Array(32);
      out.set(addr, 12);
      return out;
    }
    case 'bool': {
      if (typeof v !== 'boolean') throw new EvmAbiError(`bool: want boolean, got ${typeof v}`);
      const out = new Uint8Array(32);
      if (v) out[31] = 1;
      return out;
    }
    case 'bytesN': {
      const b = toBytes(v);
      if (b.length !== t.size) throw new EvmAbiError(`bytes${t.size}: expected ${t.size} bytes, got ${b.length}`);
      const out = new Uint8Array(32);
      out.set(b, 0);
      return out;
    }
    case 'bytes':
      return encodeDynBytes(toBytes(v));
    case 'string':
      if (typeof v !== 'string') throw new EvmAbiError(`string: want string, got ${typeof v}`);
      return encodeDynBytes(new TextEncoder().encode(v));
    case 'array': {
      if (!Array.isArray(v)) throw new EvmAbiError(`array: want array, got ${typeof v}`);
      if (t.size >= 0 && v.length !== t.size) {
        throw new EvmAbiError(`fixed array T[${t.size}]: expected ${t.size} items, got ${v.length}`);
      }
      const inner = v.map(() => t.element!);
      const body = encodeComponents(inner, v);
      if (t.size < 0) return concat([uint256Bytes(BigInt(v.length)), body]);
      return body;
    }
  }
}

/** Head/tail packer for top-level tuples and dynamic arrays. */
function encodeComponents(types: AbiType[], args: unknown[]): Uint8Array {
  const tails = types.map((t, i) => {
    try {
      return encodeOne(t, args[i]);
    } catch (err) {
      throw err instanceof CryptoChiefError ? new EvmAbiError(`arg ${i}: ${stripPrefix(err.message)}`) : err;
    }
  });
  const headSize = 32 * types.length;
  const heads: Uint8Array[] = [];
  let cursor = headSize;
  const offsets: number[] = [];
  for (let i = 0; i < types.length; i++) {
    if (isDynamic(types[i]!)) {
      offsets[i] = cursor;
      cursor += tails[i]!.length;
    }
  }
  for (let i = 0; i < types.length; i++) {
    heads.push(isDynamic(types[i]!) ? uint256Bytes(BigInt(offsets[i]!)) : tails[i]!);
  }
  const dynamicTails = types.map((t, i) => (isDynamic(t) ? tails[i]! : new Uint8Array(0)));
  return concat([...heads, ...dynamicTails]);
}

function stripPrefix(msg: string): string {
  return msg.replace(/^cryptochief\/evm: /, '');
}

// -- Public API ---------------------------------------------------------------

/** The 4-byte function selector for a Solidity signature. */
export function evmSelector(signature: string): Uint8Array {
  return keccak_256(new TextEncoder().encode(canonicalSignature(signature))).subarray(0, 4);
}

/** Build ABI calldata (selector + encoded args) as raw bytes. */
export function encodeEvmCall(signature: string, ...args: unknown[]): Uint8Array {
  const { types } = parseSignature(signature);
  if (types.length !== args.length) {
    throw new EvmAbiError(`signature has ${types.length} args, got ${args.length}`);
  }
  const parsed = types.map((s, i) => {
    try {
      return parseType(s);
    } catch (err) {
      throw new EvmAbiError(`arg ${i} (${s}): ${err instanceof Error ? stripPrefix(err.message) : String(err)}`);
    }
  });
  return concat([evmSelector(signature), encodeComponents(parsed, args)]);
}

/** Build ABI calldata as a `0x...` hex string (the form the `data` field expects). */
export function encodeEvmCallHex(signature: string, ...args: unknown[]): string {
  return '0x' + Buffer.from(encodeEvmCall(signature, ...args)).toString('hex');
}

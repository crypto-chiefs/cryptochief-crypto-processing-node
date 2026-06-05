import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  anchorDiscriminator,
  borshBool,
  borshFixedBytes,
  borshOption,
  borshPubkey,
  borshString,
  borshU128,
  borshU32,
  borshU64,
  borshVec,
  encodeAnchorInstruction,
} from '../src/contract/borsh';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('anchorDiscriminator', () => {
  it('is sha256("global:"+method)[:8]', () => {
    for (const m of ['initialize', 'transfer', 'swap', 'set_authority']) {
      const want = new Uint8Array(createHash('sha256').update(`global:${m}`).digest().subarray(0, 8));
      expect(hex(anchorDiscriminator(m))).toBe(hex(want));
    }
  });
});

describe('borsh primitives', () => {
  it('u64 little-endian', () => {
    expect(hex(borshU64(1_234_567n).encode())).toBe('87d61200 00000000'.replace(/\s/g, ''));
  });

  it('u128 little-endian (1 << 64)', () => {
    const b = borshU128(1n << 64n).encode();
    expect(b.length).toBe(16);
    expect(hex(b)).toBe('00000000000000000100000000000000');
  });

  it('string = 4-byte LE length + utf8', () => {
    expect(hex(borshString('hello').encode())).toBe('0500000068656c6c6f');
  });

  it('bool', () => {
    expect(hex(borshBool(true).encode())).toBe('01');
    expect(hex(borshBool(false).encode())).toBe('00');
  });

  it('vec<u32> [1,2,3]', () => {
    expect(hex(borshVec([borshU32(1), borshU32(2), borshU32(3)]).encode())).toBe(
      '03000000' + '01000000' + '02000000' + '03000000',
    );
  });

  it('pubkey (system program = 32 zero bytes)', () => {
    const b = borshPubkey('11111111111111111111111111111111').encode();
    expect(b.length).toBe(32);
    expect(hex(b)).toBe('00'.repeat(32));
  });

  it('fixed bytes (no length prefix) + length check', () => {
    expect(hex(borshFixedBytes(new Uint8Array([1, 2, 3, 4]), 4).encode())).toBe('01020304');
    expect(() => borshFixedBytes(new Uint8Array([1, 2, 3]), 4).encode()).toThrow();
  });

  it('option none/some', () => {
    expect(hex(borshOption(null).encode())).toBe('00');
    expect(hex(borshOption(borshU32(42)).encode())).toBe('012a000000');
  });
});

describe('encodeAnchorInstruction', () => {
  it('discriminator + borsh args', () => {
    const data = encodeAnchorInstruction('transfer', borshU64(1_000n), borshBool(true));
    expect(hex(data.subarray(0, 8))).toBe(hex(anchorDiscriminator('transfer')));
    expect(hex(data.subarray(8, 16))).toBe('e803000000000000'); // u64 1000 LE
    expect(data[16]).toBe(0x01);
    expect(data.length).toBe(17);
  });
});

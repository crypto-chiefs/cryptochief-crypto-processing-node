import { describe, it, expect } from 'vitest';
import { tronToHex, hexToTron } from '../src/contract/tron-address';
import { base58Encode, base58Decode } from '../src/contract/base58';

describe('TRON address conversion (known TRC-20 contracts)', () => {
  const cases: { base58: string; hex: string }[] = [
    { base58: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', hex: '0x41a614f803b6fd780986a42c78ec9c7f77e6ded13c' }, // USDT
    { base58: 'TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S', hex: '0x41b4a428ab7092c2f1395f376ce297033b3bb446c1' }, // SUN
  ];
  for (const tc of cases) {
    it(tc.base58, () => {
      expect(tronToHex(tc.base58).toLowerCase()).toBe(tc.hex.toLowerCase());
      expect(hexToTron(tc.hex)).toBe(tc.base58);
      // 20-byte form (strip "0x41") round-trips via the auto 0x41 prefix.
      expect(hexToTron('0x' + tc.hex.slice(4))).toBe(tc.base58);
    });
  }

  it('rejects a bad checksum', () => {
    expect(() => tronToHex('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6T')).toThrow();
  });

  it('rejects malformed input', () => {
    for (const bad of ['', 'not-base58-0OIl', 'TR7NHqjeKQxGTCi']) {
      expect(() => tronToHex(bad)).toThrow();
    }
    for (const bad of ['', '0xzzz', '0xabcd', '0x42' + 'ab'.repeat(20)]) {
      expect(() => hexToTron(bad)).toThrow();
    }
  });
});

describe('base58 round-trip', () => {
  it('preserves leading zeros and arbitrary bytes', () => {
    const inputs: Uint8Array[] = [
      new Uint8Array([0x00]),
      new Uint8Array([0x00, 0x00, 0xff]),
      new Uint8Array([
        0x41, 0xa6, 0x14, 0xf8, 0x03, 0xb6, 0xfd, 0x78, 0x09, 0x86, 0xa4, 0x2c, 0x78, 0xec, 0x9c, 0x7f, 0x77,
        0xe6, 0xde, 0xd1, 0x3c, 0xb8, 0x3a, 0xfd, 0x16,
      ]),
    ];
    for (const input of inputs) {
      expect([...base58Decode(base58Encode(input))]).toEqual([...input]);
    }
  });
});

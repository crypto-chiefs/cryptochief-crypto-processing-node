import { describe, it, expect } from 'vitest';
import { humanToBase, baseToHuman, nanoTon, InvalidAmountError } from '../src/amount';

describe('humanToBase', () => {
  it('converts with full precision', () => {
    expect(humanToBase('1.5', 18)).toBe(1_500_000_000_000_000_000n);
    expect(humanToBase('0.0001', 8)).toBe(10_000n);
    expect(humanToBase('0.5', 6)).toBe(500_000n);
    expect(humanToBase('12.5', 6)).toBe(12_500_000n);
    expect(humanToBase('0', 18)).toBe(0n);
    expect(humanToBase('100', 0)).toBe(100n);
  });

  it('truncates sub-base-unit precision', () => {
    expect(humanToBase('1.123456789', 6)).toBe(1_123_456n);
  });

  it('rejects negatives and scientific notation', () => {
    expect(() => humanToBase('-1', 18)).toThrow(InvalidAmountError);
    expect(() => humanToBase('1e3', 18)).toThrow(InvalidAmountError);
    expect(() => humanToBase('', 18)).toThrow(InvalidAmountError);
    expect(() => humanToBase('1.2.3', 18)).toThrow(InvalidAmountError);
    expect(() => humanToBase('abc', 18)).toThrow(InvalidAmountError);
  });
});

describe('baseToHuman', () => {
  it('formats and trims trailing zeroes', () => {
    expect(baseToHuman(1_500_000_000_000_000_000n, 18)).toBe('1.5');
    expect(baseToHuman(0n, 18)).toBe('0');
    expect(baseToHuman(10_000n, 8)).toBe('0.0001');
    expect(baseToHuman(100n, 0)).toBe('100');
  });

  it('round-trips with humanToBase', () => {
    for (const [h, d] of [
      ['123.456', 18],
      ['0.000001', 6],
      ['1000000', 8],
    ] as const) {
      expect(baseToHuman(humanToBase(h, d), d)).toBe(h);
    }
  });
});

describe('nanoTon', () => {
  it('converts human TON to nanoTON', () => {
    expect(nanoTon('0.05')).toBe(50_000_000n);
    expect(nanoTon('1')).toBe(1_000_000_000n);
  });
});

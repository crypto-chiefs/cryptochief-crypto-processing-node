import { describe, it, expect } from 'vitest';
import {
  parseTonAddress,
  tonAddressToString,
  tonAddressToRaw,
  crc16Xmodem,
  type TonAddress,
} from '../src/ton/address';

const USDT_MASTER = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
const HASH_HEX = 'b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe';

function hexBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

describe('parseTonAddress', () => {
  it('round-trips a user-friendly bounceable address', () => {
    const a = parseTonAddress(USDT_MASTER);
    expect(a.workchain).toBe(0);
    expect(a.bounceable).toBe(true);
    expect(a.testnet).toBe(false);
    expect(tonAddressToString(a)).toBe(USDT_MASTER);
  });

  it('parses the raw workchain:hex form', () => {
    const a = parseTonAddress('0:' + HASH_HEX);
    expect([...a.hash]).toEqual([...hexBytes(HASH_HEX)]);
    expect(tonAddressToRaw(a)).toBe('0:' + HASH_HEX);
  });

  it('user-friendly and raw forms agree', () => {
    const a1 = parseTonAddress(USDT_MASTER);
    const a2 = parseTonAddress(tonAddressToRaw(a1));
    expect(a2.workchain).toBe(a1.workchain);
    expect([...a2.hash]).toEqual([...a1.hash]);
  });

  it('encodes/decodes a UQ non-bounceable address', () => {
    const a: TonAddress = { workchain: 0, hash: hexBytes(HASH_HEX), bounceable: false, testnet: false };
    const uq = tonAddressToString(a);
    expect(uq.startsWith('UQ')).toBe(true);
    const back = parseTonAddress(uq);
    expect(back.bounceable).toBe(false);
    expect([...back.hash]).toEqual([...a.hash]);
  });

  it('rejects malformed addresses', () => {
    for (const bad of [
      '',
      'not-an-address',
      'EQ_too_short',
      'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_AAA', // corrupt CRC
      'foo:' + HASH_HEX, // bad workchain
      '0:abcd', // bad hash length
    ]) {
      expect(() => parseTonAddress(bad)).toThrow();
    }
  });
});

describe('crc16Xmodem', () => {
  it('matches the canonical vector', () => {
    expect(crc16Xmodem(new TextEncoder().encode('123456789'))).toBe(0x31c3);
    expect(crc16Xmodem(new Uint8Array(0))).toBe(0);
  });
});

import { CryptoChiefError } from '../errors';

/**
 * Offline parsing / validation of TON addresses. TON addresses come in three
 * skins, all wrapping the same 33 bytes (1 tag + 1 workchain + 32 hash):
 *
 *  - user-friendly bounceable      `EQ...` (mainnet) / `kQ...` (testnet)
 *  - user-friendly non-bounceable  `UQ...` (mainnet) / `0Q...` (testnet)
 *  - raw                            `<workchain>:<32-byte-hex>`
 *
 * The user-friendly forms add a 2-byte CRC16-XMODEM checksum, which this parser
 * validates.
 */
export interface TonAddress {
  workchain: number;
  hash: Uint8Array; // 32 bytes
  bounceable: boolean;
  testnet: boolean;
}

/** CRC-16/XMODEM (poly 0x1021, init 0x0000, non-reflected) - TON's address checksum. */
export function crc16Xmodem(data: Uint8Array): number {
  let crc = 0;
  for (const b of data) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new CryptoChiefError('cryptochief/ton: odd-length hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new CryptoChiefError(`cryptochief/ton: bad hash hex`);
    out[i] = byte;
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

function parseRaw(s: string, colon: number): TonAddress {
  const wc = Number.parseInt(s.slice(0, colon), 10);
  if (!Number.isInteger(wc) || wc < -128 || wc > 127) {
    throw new CryptoChiefError(`cryptochief/ton: bad raw workchain ${JSON.stringify(s.slice(0, colon))}`);
  }
  const hashHex = s.slice(colon + 1);
  if (hashHex.length !== 64) {
    throw new CryptoChiefError(`cryptochief/ton: hash hex length ${hashHex.length}, want 64`);
  }
  return { workchain: wc, hash: hexToBytes(hashHex), bounceable: true, testnet: false };
}

function parseFriendly(s: string): TonAddress {
  if (s.length !== 48) {
    throw new CryptoChiefError(`cryptochief/ton: user-friendly address length ${s.length}, want 48`);
  }
  // TON uses URL-safe base64; some wallets emit standard base64. Buffer's
  // base64 decoder accepts both alphabets.
  const raw = new Uint8Array(Buffer.from(s, 'base64'));
  if (raw.length !== 36) {
    throw new CryptoChiefError(`cryptochief/ton: decoded length ${raw.length}, want 36`);
  }
  const want = crc16Xmodem(raw.subarray(0, 34));
  const got = (raw[34]! << 8) | raw[35]!;
  if (want !== got) throw new CryptoChiefError('cryptochief/ton: CRC mismatch');
  const tag = raw[0]!;
  return {
    workchain: (raw[1]! << 24) >> 24, // sign-extend to int8
    hash: raw.slice(2, 34),
    bounceable: (tag & 0x40) === 0,
    testnet: (tag & 0x80) !== 0,
  };
}

/** Parse any of the three TON address forms; throws on CRC/length errors. */
export function parseTonAddress(input: string): TonAddress {
  const s = input.trim();
  if (s === '') throw new CryptoChiefError('cryptochief/ton: empty address');
  const colon = s.indexOf(':');
  if (colon > 0) return parseRaw(s, colon);
  return parseFriendly(s);
}

/** Render the user-friendly form (URL-safe base64, no padding). */
export function tonAddressToString(a: TonAddress): string {
  let tag = a.bounceable ? 0x11 : 0x51;
  if (a.testnet) tag |= 0x80;
  const buf = new Uint8Array(36);
  buf[0] = tag;
  buf[1] = a.workchain & 0xff;
  buf.set(a.hash.subarray(0, 32), 2);
  const crc = crc16Xmodem(buf.subarray(0, 34));
  buf[34] = crc >> 8;
  buf[35] = crc & 0xff;
  return Buffer.from(buf).toString('base64url');
}

/** Render the raw `workchain:hex` form. */
export function tonAddressToRaw(a: TonAddress): string {
  return `${a.workchain}:${bytesToHex(a.hash)}`;
}

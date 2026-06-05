import { describe, it, expect } from 'vitest';
import { encodeEvmCall, encodeEvmCallHex, evmSelector } from '../src/contract/evm-abi';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const selHex = (sig: string) => hex(evmSelector(sig));

describe('evmSelector (well-known Ethereum selectors)', () => {
  const cases: [string, string][] = [
    ['transfer(address,uint256)', 'a9059cbb'],
    ['approve(address,uint256)', '095ea7b3'],
    ['balanceOf(address)', '70a08231'],
    ['totalSupply()', '18160ddd'],
    ['transferFrom(address,address,uint256)', '23b872dd'],
    ['swapExactTokensForTokens(uint256,uint256,address[],address,uint256)', '38ed1739'],
    ['transfer(address,uint)', 'a9059cbb'], // alias uint -> uint256
    ['transfer(address to, uint256 amount)', 'a9059cbb'], // strip names/spaces
  ];
  for (const [sig, want] of cases) {
    it(sig, () => expect(selHex(sig)).toBe(want));
  }
});

describe('encodeEvmCall', () => {
  it('encodes a standard ERC-20 transfer', () => {
    const data = encodeEvmCall(
      'transfer(address,uint256)',
      '0xbcd4042de499d14e55001ccbb24a551f3b954096',
      1_000_000n,
    );
    expect(hex(data)).toBe(
      'a9059cbb' +
        '000000000000000000000000bcd4042de499d14e55001ccbb24a551f3b954096' +
        '00000000000000000000000000000000000000000000000000000000000f4240',
    );
  });

  it('head/tail packs dynamic arrays', () => {
    const data = encodeEvmCall(
      'multiSend(address[],uint256[])',
      ['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
      [100n, 200n],
    );
    expect(hex(data)).toBe(
      selHex('multiSend(address[],uint256[])') +
        '0000000000000000000000000000000000000000000000000000000000000040' +
        '00000000000000000000000000000000000000000000000000000000000000a0' +
        '0000000000000000000000000000000000000000000000000000000000000002' +
        '000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' +
        '000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' +
        '0000000000000000000000000000000000000000000000000000000000000002' +
        '0000000000000000000000000000000000000000000000000000000000000064' +
        '00000000000000000000000000000000000000000000000000000000000000c8',
    );
  });

  it('encodes dynamic bytes + string with padded tails', () => {
    const data = encodeEvmCall('bar(bytes,string)', '0xdeadbeef', 'hello');
    expect(hex(data)).toBe(
      selHex('bar(bytes,string)') +
        '0000000000000000000000000000000000000000000000000000000000000040' +
        '0000000000000000000000000000000000000000000000000000000000000080' +
        '0000000000000000000000000000000000000000000000000000000000000004' +
        'deadbeef00000000000000000000000000000000000000000000000000000000' +
        '0000000000000000000000000000000000000000000000000000000000000005' +
        '68656c6c6f000000000000000000000000000000000000000000000000000000',
    );
  });

  it('accepts a TRON base58 address inside an ABI argument', () => {
    const data = encodeEvmCall('balanceOf(address)', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
    expect(hex(data.subarray(0, 4))).toBe(selHex('balanceOf(address)'));
    expect(hex(data.subarray(16, 36))).toBe('a614f803b6fd780986a42c78ec9c7f77e6ded13c');
    expect(hex(data.subarray(4, 16))).toBe('00'.repeat(12)); // left-padded
  });

  it('rejects wrong-length bytesN and arg-count mismatch', () => {
    expect(() => encodeEvmCall('twiddle(bool,bytes32)', true, '0xdeadbeef')).toThrow(/expected 32 bytes/);
    expect(() => encodeEvmCall('transfer(address,uint256)', '0x00')).toThrow();
  });

  it('canonicalizes aliases and whitespace identically', () => {
    const want =
      'a9059cbb' +
      '000000000000000000000000bcd4042de499d14e55001ccbb24a551f3b954096' +
      '00000000000000000000000000000000000000000000000000000000000f4240';
    for (const sig of [
      'transfer(address,uint256)',
      'transfer(address,uint)',
      'transfer(address to, uint256 amount)',
      'transfer ( address to , uint amount )',
    ]) {
      expect(encodeEvmCallHex(sig, '0xbcd4042de499d14e55001ccbb24a551f3b954096', 1_000_000n).slice(2)).toBe(want);
    }
  });
});

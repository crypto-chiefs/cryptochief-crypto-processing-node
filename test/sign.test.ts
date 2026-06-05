import { describe, it, expect } from 'vitest';
import { canonicalJSON, sign } from '../src/sign';

/**
 * Signature regression suite - fixed payloads with known-correct hashes. A
 * drift in canonical JSON or MD5 wiring fails here before it can fail against
 * the live API. Secret: "test_api_key_123".
 */
const SECRET = 'test_api_key_123';

describe('signature regression vectors', () => {
  const cases: { name: string; body: unknown; want: string; wantCan?: string }[] = [
    {
      name: 'payout estimate body',
      body: {
        network: 'ETH_SEPOLIA',
        coin: 'ETH',
        amount: '0.0001',
        to_address: '0xAbC',
        from_addresses: ['0x111', '0x222'],
      },
      want: '97bd68e4e4dc86b6dad8aa06e1f7b63d',
      wantCan:
        '{"amount":"0.0001","coin":"ETH","from_addresses":["0x111","0x222"],"network":"ETH_SEPOLIA","to_address":"0xAbC"}',
    },
    {
      name: 'batch payout body, url with HTML-escaped chars',
      body: {
        items: [
          { order_id: 'b', user_id: 'u', amount: '1' },
          { order_id: 'a', user_id: 'u2', amount: '2' },
        ],
        url_callback: 'https://x.io/cb?a=1&b=2',
      },
      want: '8b85b5464c9a92059a74039d7a008618',
    },
    {
      name: 'nested map + array, HTML chars in values',
      body: {
        z: true,
        a: 1,
        m: { y: '<tag>', x: 'a&b' },
        arr: [3, 2, 1],
      },
      want: '5fcfb2c41ee9d91073b9adcf22fe8a79',
    },
    {
      name: 'empty body',
      body: {},
      want: '33d8723e69fba9d68b8991ad200be4b3',
      wantCan: '{}',
    },
  ];

  for (const tc of cases) {
    it(tc.name, () => {
      const canonical = canonicalJSON(tc.body);
      if (tc.wantCan !== undefined) {
        expect(canonical).toBe(tc.wantCan);
      }
      expect(sign(canonical, SECRET)).toBe(tc.want);
    });
  }
});

describe('canonicalization edge cases', () => {
  it('empty/undefined body signs as md5(apiKey)', () => {
    expect(canonicalJSON(undefined)).toBe('');
    // md5("" + key) with key signed over base64("")="" -> md5(key).
    expect(sign('', SECRET)).toBe(sign(canonicalJSON(undefined), SECRET));
  });

  it('drops undefined and null fields, keeps explicit empties', () => {
    expect(canonicalJSON({ b: undefined, a: 'x', c: null })).toBe('{"a":"x"}');
    expect(canonicalJSON({ a: '', b: [] })).toBe('{"a":"","b":[]}');
  });

  it('HTML-escapes < > & and the line/paragraph separators', () => {
    expect(canonicalJSON({ k: '<a>&  ' })).toBe('{"k":"\\u003ca\\u003e\\u0026\\u2028\\u2029"}');
  });
});

import { createHash } from 'node:crypto';
import { CryptoChiefError } from './errors';

/**
 * Canonical JSON + request signing.
 *
 * Crypto Chief signs the *canonical* serialization of a request body. The
 * canonical form is fully deterministic:
 *
 *  - object keys sorted lexicographically by UTF-8 bytes, recursively;
 *  - compact (no insignificant whitespace);
 *  - the HTML-sensitive characters `<`, `>`, `&` and the U+2028 / U+2029
 *    line/paragraph separators emitted as their JSON unicode escapes;
 *  - standard JSON escapes for `"`, `\`, and control characters (`\n`, `\r`,
 *    `\t` short forms; everything else below 0x20 as `\u00XX`, lowercase hex).
 *
 * The gateway re-derives this canonical form from the bytes it receives and
 * checks the signature against it, so the client must emit byte-identical
 * output. The regression vectors in `test/sign.test.ts` lock this down.
 */

/** Compare two strings by their UTF-8 byte sequences. */
function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function encodeString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    switch (c) {
      case 0x22:
        out += '\\"';
        break;
      case 0x5c:
        out += '\\\\';
        break;
      case 0x0a:
        out += '\\n';
        break;
      case 0x0d:
        out += '\\r';
        break;
      case 0x09:
        out += '\\t';
        break;
      case 0x3c:
        out += '\\u003c';
        break;
      case 0x3e:
        out += '\\u003e';
        break;
      case 0x26:
        out += '\\u0026';
        break;
      case 0x2028:
        out += '\\u2028';
        break;
      case 0x2029:
        out += '\\u2029';
        break;
      default:
        if (c < 0x20) {
          out += '\\u00' + c.toString(16).padStart(2, '0');
        } else {
          // Pass through, including surrogate halves - UTF-8 encoding at the
          // base64 step reassembles them correctly.
          out += s[i];
        }
    }
  }
  return out + '"';
}

function encodeNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new CryptoChiefError(`cryptochief: cannot canonicalize non-finite number ${n}`);
  }
  // Integers print without a decimal point. The API convention is to pass
  // amounts as strings, so fractional numbers are not expected in signed bodies.
  return n.toString();
}

function encodeValue(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  switch (typeof v) {
    case 'string':
      return encodeString(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      return encodeNumber(v);
    case 'bigint':
      return v.toString();
    case 'object': {
      if (Array.isArray(v)) {
        return '[' + v.map((el) => encodeValue(el)).join(',') + ']';
      }
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined && obj[k] !== null);
      keys.sort(compareUtf8);
      const parts = keys.map((k) => encodeString(k) + ':' + encodeValue(obj[k]));
      return '{' + parts.join(',') + '}';
    }
    default:
      throw new CryptoChiefError(`cryptochief: cannot canonicalize value of type ${typeof v}`);
  }
}

/**
 * Produce the canonical JSON string for a value. `undefined`/`null` collapse to
 * an empty body, which signs as `md5(apiKey)`.
 */
export function canonicalJSON(value: unknown): string {
  if (value === undefined || value === null) return '';
  return encodeValue(value);
}

/**
 * Compute the `Signature` header value for an already-canonical body:
 * `hex(md5(base64(canonicalBody) + apiKey))`. An empty body signs as
 * `md5(apiKey)`.
 */
export function sign(canonicalBody: string, apiKey: string): string {
  const b64 = Buffer.from(canonicalBody, 'utf8').toString('base64');
  return createHash('md5')
    .update(b64 + apiKey)
    .digest('hex');
}

/** Canonicalize then sign a value in one step. */
export function signValue(value: unknown, apiKey: string): { canonical: string; signature: string } {
  const canonical = canonicalJSON(value);
  return { canonical, signature: sign(canonical, apiKey) };
}

/**
 * Case conversion between the camelCase public API surface and the snake_case
 * wire format. Requests are converted to snake_case before signing; responses
 * are converted to camelCase before they reach the caller. Keeping the public
 * types camelCase is the JavaScript convention; the wire stays snake_case to
 * match the REST API and its documentation.
 *
 * Only object *keys* are transformed - string values (chain codes, amounts,
 * addresses) pass through untouched, as do `bigint`/`number`/`boolean`/`null`.
 */

import { CryptoChiefError } from './errors';

/** Deeper values are rejected by the API's JSON parser. */
const MAX_DEPTH = 10000;

function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
}

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Deep copy with renamed keys, without recursion. Arrays keep holes. */
function mapKeys(value: unknown, rename: (k: string) => string, dropUndefined: boolean): unknown {
  const pending: [source: unknown, target: Record<string, unknown> | unknown[], depth: number][] = [];
  const copy = (v: unknown, depth: number): unknown => {
    if (!Array.isArray(v) && !isPlainObject(v)) return v;
    if (depth > MAX_DEPTH) throw new CryptoChiefError(`cryptochief: nesting deeper than ${MAX_DEPTH}`);
    const target = Array.isArray(v) ? new Array<unknown>(v.length) : {};
    pending.push([v, target, depth]);
    return target;
  };
  const root = copy(value, 1);
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    const [source, target, depth] = item;
    if (Array.isArray(source)) {
      const arr = target as unknown[];
      for (let i = 0; i < source.length; i++) {
        if (i in source) arr[i] = copy(source[i], depth + 1);
      }
    } else {
      const obj = target as Record<string, unknown>;
      for (const [k, v] of Object.entries(source as Record<string, unknown>)) {
        if (dropUndefined && v === undefined) continue;
        obj[rename(k)] = copy(v, depth + 1);
      }
    }
  }
  return root;
}

/** Deep-convert a request value to its snake_case wire form, dropping `undefined`. */
export function toWire(value: unknown): unknown {
  return mapKeys(value, camelToSnake, true);
}

/** Deep-convert a wire response value to its camelCase public form. */
export function fromWire(value: unknown): unknown {
  return mapKeys(value, snakeToCamel, false);
}

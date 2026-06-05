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

/** Deep-convert a request value to its snake_case wire form, dropping `undefined`. */
export function toWire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toWire);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[camelToSnake(k)] = toWire(v);
    }
    return out;
  }
  return value;
}

/** Deep-convert a wire response value to its camelCase public form. */
export function fromWire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fromWire);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[snakeToCamel(k)] = fromWire(v);
    }
    return out;
  }
  return value;
}

import { CryptoChiefError } from './errors';

const MAX_DEPTH = 10000;

type Frame =
  | { kind: 'array'; source: readonly unknown[]; index: number; depth: number }
  | { kind: 'object'; source: Record<string, unknown>; keys: string[]; index: number; depth: number; empty: boolean };

/**
 * Request body as sent: compact JSON of the value.
 *
 * - `undefined` and `null` give an empty body;
 * - object fields that are `null` or `undefined` are omitted, keys keep the
 *   value's order; every non-array object is written as its own enumerable
 *   string keys;
 * - array elements that are `null`, `undefined` or holes are `null`;
 * - `bigint` is written as its exact integer; `-0` as `0`.
 *
 * Throws {@link CryptoChiefError} on a non-finite number, a function or
 * symbol, and nesting deeper than 10000 levels.
 */
export function encodeRequestBody(value: unknown): string {
  if (value === undefined || value === null) return '';
  const out: string[] = [];
  const stack: Frame[] = [];

  const write = (v: unknown, depth: number): void => {
    switch (typeof v) {
      case 'string':
        out.push(JSON.stringify(v));
        return;
      case 'number':
        if (!Number.isFinite(v)) throw new CryptoChiefError(`cryptochief: cannot encode ${v} as JSON`);
        out.push(String(v));
        return;
      case 'bigint':
        out.push(v.toString());
        return;
      case 'boolean':
        out.push(v ? 'true' : 'false');
        return;
      case 'undefined':
        out.push('null');
        return;
      case 'object':
        if (v === null) {
          out.push('null');
          return;
        }
        if (depth > MAX_DEPTH) throw new CryptoChiefError(`cryptochief: nesting deeper than ${MAX_DEPTH}`);
        if (Array.isArray(v)) {
          out.push('[');
          stack.push({ kind: 'array', source: v, index: 0, depth });
        } else {
          out.push('{');
          const source = v as Record<string, unknown>;
          stack.push({ kind: 'object', source, keys: Object.keys(source), index: 0, depth, empty: true });
        }
        return;
      default:
        throw new CryptoChiefError(`cryptochief: cannot encode a ${typeof v} as JSON`);
    }
  };

  write(value, 1);
  while (stack.length > 0) {
    const f = stack[stack.length - 1]!;
    if (f.kind === 'array') {
      if (f.index < f.source.length) {
        const i = f.index++;
        if (i > 0) out.push(',');
        write(f.source[i], f.depth + 1);
      } else {
        stack.pop();
        out.push(']');
      }
      continue;
    }
    let wrote = false;
    while (f.index < f.keys.length) {
      const k = f.keys[f.index++]!;
      const v = f.source[k];
      if (v === null || v === undefined) continue;
      if (!f.empty) out.push(',');
      f.empty = false;
      out.push(JSON.stringify(k), ':');
      write(v, f.depth + 1);
      wrote = true;
      break;
    }
    if (!wrote) {
      stack.pop();
      out.push('}');
    }
  }
  return out.join('');
}

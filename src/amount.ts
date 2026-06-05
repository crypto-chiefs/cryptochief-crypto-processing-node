import { CryptoChiefError } from './errors';

/**
 * Amount conversion helpers backed by native `bigint`. **Never use `number`
 * (IEEE-754 float) for crypto amounts**: `0.1 + 0.2 !== 0.3`, and large token
 * values exceed `Number.MAX_SAFE_INTEGER`.
 */

/** Thrown by {@link humanToBase} when its input is not a plain decimal number. */
export class InvalidAmountError extends CryptoChiefError {
  constructor(message: string) {
    super(`cryptochief: invalid amount: ${message}`);
    this.name = 'InvalidAmountError';
  }
}

function isAllDigits(s: string): boolean {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x30 || c > 0x39) return false;
  }
  return true;
}

/**
 * Convert a decimal human-readable amount string (e.g. `"0.0001"`) to its
 * base-unit integer (wei / satoshi / lamports / nanoTON / ...) for the given
 * number of decimals.
 *
 * Precise to the last digit. Negative amounts and scientific notation are
 * rejected. Sub-base-unit precision is truncated, since it is meaningless
 * on-chain.
 *
 * ```ts
 * humanToBase('1.5', 18);   // 1500000000000000000n
 * humanToBase('0.0001', 8); // 10000n
 * ```
 */
export function humanToBase(human: string, decimals: number): bigint {
  const s = human.trim();
  if (s === '') throw new InvalidAmountError('empty');
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new InvalidAmountError(`negative or non-integer decimals ${decimals}`);
  }
  if (s.includes('e') || s.includes('E')) {
    throw new InvalidAmountError(`scientific notation not allowed: ${JSON.stringify(human)}`);
  }
  if (s.startsWith('-')) {
    throw new InvalidAmountError(`negative not allowed: ${JSON.stringify(human)}`);
  }

  const dot = s.indexOf('.');
  let intPart: string;
  let fracPart: string;
  if (dot < 0) {
    if (!isAllDigits(s)) throw new InvalidAmountError(JSON.stringify(human));
    intPart = s;
    fracPart = '';
  } else {
    intPart = s.slice(0, dot) || '0';
    fracPart = s.slice(dot + 1);
    if (fracPart === '') throw new InvalidAmountError(JSON.stringify(human));
    if (!isAllDigits(intPart) || !isAllDigits(fracPart)) {
      throw new InvalidAmountError(JSON.stringify(human));
    }
  }

  // Pad or truncate the fractional part to exactly `decimals` digits.
  if (fracPart.length > decimals) {
    fracPart = fracPart.slice(0, decimals);
  } else if (fracPart.length < decimals) {
    fracPart = fracPart.padEnd(decimals, '0');
  }

  const combined = (intPart + fracPart).replace(/^0+/, '') || '0';
  return BigInt(combined);
}

/**
 * Inverse of {@link humanToBase}: turn a base-unit integer into a decimal
 * string with the given decimals, trimming trailing zeroes.
 *
 * ```ts
 * baseToHuman(1500000000000000000n, 18); // "1.5"
 * baseToHuman(0n, 18);                    // "0"
 * ```
 */
export function baseToHuman(base: bigint, decimals: number): string {
  if (decimals < 0) decimals = 0;
  let abs = (base < 0n ? -base : base).toString();
  if (decimals === 0) return abs;
  if (abs.length <= decimals) {
    abs = '0'.repeat(decimals - abs.length + 1) + abs;
  }
  const cut = abs.length - decimals;
  const intPart = abs.slice(0, cut);
  const fracPart = abs.slice(cut).replace(/0+$/, '');
  return fracPart === '' ? intPart : `${intPart}.${fracPart}`;
}

/**
 * Convert a human-friendly TON amount (`"0.05"`) into base-unit nanoTON
 * (`50000000n`) - the form the TON helpers' `attachedTon` / `forwardTonAmount`
 * fields expect. Equivalent to `humanToBase(human, 9)`.
 */
export function nanoTon(human: string): bigint {
  return humanToBase(human, 9);
}

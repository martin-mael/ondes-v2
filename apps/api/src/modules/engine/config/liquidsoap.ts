// Liquidsoap literals for generated code. Every value that reaches the rendered script
// goes through one of these, so settings can never inject code into it.

const SAFE = /^[A-Za-z0-9 _.,:/@+=-]$/;

/**
 * A double-quoted Liquidsoap string. Anything outside a small safe set, including `"`,
 * `\`, `#` (string interpolation is `#{...}`) and every non-ASCII byte, is written as a
 * `\xHH` escape of its UTF-8 bytes, which Liquidsoap 2.4 decodes back to the same bytes.
 */
export function liqString(value: string): string {
  let out = '"';
  for (const ch of value) {
    if (SAFE.test(ch)) out += ch;
    else
      for (const byte of Buffer.from(ch, 'utf8')) out += `\\x${byte.toString(16).padStart(2, '0')}`;
  }
  return `${out}"`;
}

/** A Liquidsoap float: always has a dot (`3.`, `-40.`, `0.25`), never an exponent. */
export function liqFloat(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError(`not a finite number: ${value}`);
  if (Number.isInteger(value)) return `${value}.`;
  const s = String(value);
  return s.includes('e') ? value.toFixed(12).replace(/0+$/, '') : s;
}

export function liqInt(value: number): string {
  if (!Number.isSafeInteger(value)) throw new RangeError(`not an integer: ${value}`);
  return String(value);
}

export function liqBool(value: boolean): string {
  return value ? 'true' : 'false';
}

import { describe, expect, it } from 'vitest';
import { liqBool, liqFloat, liqInt, liqString } from './liquidsoap.ts';

describe('liqString', () => {
  it('keeps plain text readable', () => {
    expect(liqString('Vandale Radio')).toBe('"Vandale Radio"');
    expect(liqString('http://api:3000/x-y_z')).toBe('"http://api:3000/x-y_z"');
  });

  it('escapes quotes, backslashes and interpolation', () => {
    expect(liqString('a"b\\c #{shutdown()}')).toBe(
      '"a\\x22b\\x5cc \\x23\\x7bshutdown\\x28\\x29\\x7d"',
    );
  });

  it('writes non-ASCII as UTF-8 bytes', () => {
    expect(liqString('é🎧')).toBe('"\\xc3\\xa9\\xf0\\x9f\\x8e\\xa7"');
    expect(liqString('a\nb')).toBe('"a\\x0ab"');
  });
});

describe('number literals', () => {
  it('always gives floats a dot and no exponent', () => {
    expect(liqFloat(3)).toBe('3.');
    expect(liqFloat(-40)).toBe('-40.');
    expect(liqFloat(0.25)).toBe('0.25');
    expect(liqFloat(1e-7)).toBe('0.0000001');
    expect(() => liqFloat(Number.NaN)).toThrow();
  });

  it('accepts integers only as ints', () => {
    expect(liqInt(7000)).toBe('7000');
    expect(() => liqInt(1.5)).toThrow();
  });

  it('writes booleans', () => {
    expect(liqBool(true)).toBe('true');
    expect(liqBool(false)).toBe('false');
  });
});

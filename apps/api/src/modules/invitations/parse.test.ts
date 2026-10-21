import { describe, expect, it } from 'vitest';
import { parseCsv, parseCsvList, parseEmailList } from './parse.ts';

describe('parseEmailList', () => {
  it('splits on newlines, commas, semicolons and spaces, with line numbers', () => {
    const rows = parseEmailList('a@x.org, b@x.org\n\nc@x.org; d@x.org e@x.org');
    expect(rows.map((r) => [r.line, r.email])).toEqual([
      [1, 'a@x.org'],
      [1, 'b@x.org'],
      [3, 'c@x.org'],
      [3, 'd@x.org'],
      [3, 'e@x.org'],
    ]);
  });

  it('reads the "Name <email>" form', () => {
    const [row] = parseEmailList('"Jane Doe" <jane@x.org>');
    expect(row).toMatchObject({ email: 'jane@x.org', name: 'Jane Doe' });
  });
});

describe('parseCsvList', () => {
  it('skips a header and blank lines, trims cells, keeps optional columns', () => {
    const rows = parseCsvList(
      'email,role,station,name\n a@x.org , presenter, morning ,Ann\n\nb@x.org,viewer\n',
    );
    expect(rows).toEqual([
      { line: 2, email: 'a@x.org', role: 'presenter', station: 'morning', name: 'Ann' },
      { line: 4, email: 'b@x.org', role: 'viewer', station: null, name: null },
    ]);
  });

  it('handles quoted cells and semicolon-separated files', () => {
    expect(parseCsv('"a@x.org";"viewer";;"Doe; ""JD"""')).toEqual([
      { line: 1, cells: ['a@x.org', 'viewer', '', 'Doe; "JD"'] },
    ]);
  });

  it('keeps line numbers across quoted newlines', () => {
    const rows = parseCsvList('a@x.org,viewer,,"two\nlines"\nb@x.org,viewer');
    expect(rows.map((r) => r.line)).toEqual([1, 3]);
  });
});

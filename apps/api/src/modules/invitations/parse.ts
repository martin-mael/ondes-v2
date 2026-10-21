// Parsing pasted invitation lists: bare emails, or CSV `email, role, station?, name?`.

export interface RawListRow {
  /** 1-based line in the input. */
  line: number;
  email: string;
  role: string | null;
  station: string | null;
  name: string | null;
}

/**
 * Pasted emails: one or more per line, separated by commas, semicolons or spaces. Accepts the
 * `Jane Doe <jane@example.org>` form mail clients copy.
 */
export function parseEmailList(text: string): RawListRow[] {
  const rows: RawListRow[] = [];
  text.split(/\r?\n/).forEach((content, i) => {
    for (const part of content.split(/[,;]/)) {
      const named = part.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
      if (named) {
        rows.push(row(i + 1, named[2] ?? '', null, null, named[1] || null));
        continue;
      }
      for (const email of part.split(/\s+/)) {
        if (email) rows.push(row(i + 1, email, null, null, null));
      }
    }
  });
  return rows;
}

/** CSV with columns `email, role, station, name`. A first line starting with `email` is a header. */
export function parseCsvList(text: string): RawListRow[] {
  const records = parseCsv(text);
  const rows: RawListRow[] = [];
  for (const [index, { line, cells }] of records.entries()) {
    if (index === 0 && cells[0]?.trim().toLowerCase() === 'email') continue;
    if (cells.every((c) => c.trim() === '')) continue;
    const [email = '', role = '', station = '', name = ''] = cells.map((c) => c.trim());
    rows.push(row(line, email, role || null, station || null, name || null));
  }
  return rows;
}

function row(
  line: number,
  email: string,
  role: string | null,
  station: string | null,
  name: string | null,
): RawListRow {
  return { line, email: email.trim(), role, station, name: name?.trim() || null };
}

/** RFC 4180-ish: comma or semicolon separated (detected on the first line), `"` quoting. */
export function parseCsv(text: string): { line: number; cells: string[] }[] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const separator = !firstLine.includes(',') && firstLine.includes(';') ? ';' : ',';
  const out: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else {
        if (ch === '\n') line++;
        cell += ch;
      }
    } else if (ch === '"' && cell.trim() === '') {
      quoted = true;
      cell = '';
    } else if (ch === separator) {
      cells.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      cells.push(cell);
      out.push({ line: recordLine, cells });
      cells = [];
      cell = '';
      line++;
      recordLine = line;
    } else cell += ch;
  }
  if (cell !== '' || cells.length > 0) {
    cells.push(cell);
    out.push({ line: recordLine, cells });
  }
  return out;
}

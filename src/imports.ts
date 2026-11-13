import { MAX_TEXT_BYTES } from './domain';

/** RFC-4180-style records, including quoted delimiters, escaped quotes and multiline cells. */
export function parseCsv(input: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false, closed = false;
  const pushCell = () => { row.push(cell); cell = ''; closed = false; };
  const pushRow = () => { pushCell(); if (row.some(value => value.trim())) rows.push(row); row = []; };
  const text = input.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') { quoted = false; closed = true; }
      else cell += ch;
    } else if (ch === ',' || ch === '\n' || ch === '\r') {
      if (ch === ',') pushCell();
      else { if (ch === '\r' && text[i + 1] === '\n') i++; pushRow(); }
    } else if (ch === '"') {
      if (cell || closed) throw new Error('CSV has a quote outside a quoted cell.');
      quoted = true;
    } else {
      if (closed) throw new Error('CSV has characters after a closing quote.');
      cell += ch;
    }
  }
  if (quoted) throw new Error('CSV has an unterminated quoted cell.');
  if (cell || row.length || closed) pushRow();
  const headers = rows.shift()?.map(value => value.trim());
  if (!headers?.length || headers.some(value => !value) || new Set(headers).size !== headers.length) throw new Error('CSV needs unique, nonempty column headings.');
  return rows.map((values, index) => {
    if (values.length !== headers.length) throw new Error(`CSV record ${index + 2} has ${values.length} cells; expected ${headers.length}.`);
    return Object.fromEntries(headers.map((header, i) => [header, values[i]]));
  });
}

export function normalizeText(filename: string, text: string): string {
  let output = text;
  if (/\.json$/i.test(filename)) {
    let value: unknown;
    try { value = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error('Invalid JSON source.'); }
    if (!value || typeof value !== 'object') throw new Error('JSON source must be an object or array.');
    output = JSON.stringify(value, null, 2);
  } else if (/\.csv$/i.test(filename)) {
    const records = parseCsv(text);
    if (!records.length) throw new Error('CSV contains no question records.');
    output = JSON.stringify(records, null, 2);
  }
  if (!output.trim() || new TextEncoder().encode(output).length > MAX_TEXT_BYTES) throw new Error('Extracted text must be nonempty and at most 2 MiB.');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(output)) throw new Error('Source contains unsupported control characters.');
  return output;
}

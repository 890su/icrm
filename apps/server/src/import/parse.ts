import type { ImportRow, ImportTable } from '@icrm/db';
import ExcelJS from 'exceljs';

/** The file is not a vCard, CSV or XLSX we can read (binary, corrupt, or without a header row). */
export class UnsupportedFormat extends Error {}

export type ParsedFile = { kind: 'vcard'; rows: ImportRow[] } | { kind: 'table'; table: ImportTable };

const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];

const isZip = (bytes: Uint8Array): boolean => ZIP_SIGNATURE.every((b, i) => bytes[i] === b);

const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/** UTF-8 when the bytes are valid UTF-8, otherwise Windows-1250 (Polish Excel). */
function decodeText(bytes: Uint8Array): string {
  try {
    return stripBom(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return stripBom(new TextDecoder('windows-1250').decode(bytes));
  }
}

export async function parseImportFile(bytes: Uint8Array): Promise<ParsedFile> {
  if (isZip(bytes)) {
    return tableResult(await parseXlsx(bytes));
  }
  if (bytes.includes(0)) {
    throw new UnsupportedFormat('binary file');
  }
  const text = decodeText(bytes);
  if (/^\s*BEGIN:VCARD/i.test(text)) {
    return { kind: 'vcard', rows: parseVcard(text) };
  }
  return tableResult(parseCsv(bytes));
}

function tableResult(table: ImportTable): ParsedFile {
  if (!table.headers.some((h) => h !== '')) {
    throw new UnsupportedFormat('no header row');
  }
  return { kind: 'table', table };
}

// ---------------------------------------------------------------- vCard

const unescapeVcard = (s: string): string =>
  s.replace(/\\([nN,;\\])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));

/** Splits on `;` that is not escaped, then unescapes each part. */
const splitStructured = (value: string): string[] =>
  value.split(/(?<!\\);/).map(unescapeVcard);

interface Prop { name: string; value: string }

function unfold(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r\n|\n|\r/)) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

function parseProp(line: string): Prop | null {
  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ':' && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon).split(';')[0]!;
  const name = head.slice(head.lastIndexOf('.') + 1).trim().toUpperCase();
  return { name, value: line.slice(colon + 1) };
}

function cardRow(line: number, props: Prop[]): ImportRow {
  const first = (name: string): string | null => {
    const found = props.find((p) => p.name === name && p.value.trim() !== '');
    return found ? found.value : null;
  };
  let title: string | null = null;
  const fn = first('FN');
  if (fn !== null) {
    title = unescapeVcard(fn).trim();
  } else {
    const n = first('N');
    if (n !== null) {
      const [family = '', given = ''] = splitStructured(n);
      title = [given, family].map((s) => s.trim()).filter((s) => s !== '').join(' ');
    }
  }
  const identities: ImportRow['identities'] = [];
  for (const p of props) {
    if (p.name !== 'TEL' && p.name !== 'EMAIL') continue;
    let address = unescapeVcard(p.value).trim();
    if (p.name === 'TEL') address = address.replace(/^tel:/i, '').trim();
    if (address !== '') identities.push({ channel: p.name === 'TEL' ? 'phone' : 'email', address });
  }
  const org = first('ORG');
  const orgTitle = org === null ? '' : (splitStructured(org)[0] ?? '').trim();
  const position = first('TITLE');
  const notes = props.filter((p) => p.name === 'NOTE' && p.value.trim() !== '').map((p) => unescapeVcard(p.value));
  const hasOrg = orgTitle !== '';
  return {
    line,
    contact: { title: title === '' ? null : title, data: notes.length > 0 ? { notes: notes.join('\n') } : {} },
    identities,
    organization: hasOrg ? { title: orgTitle, nip: null, data: {} } : null,
    membership: hasOrg ? { role: [], position: position === null ? null : unescapeVcard(position).trim() } : null,
  };
}

export function parseVcard(text: string): ImportRow[] {
  const rows: ImportRow[] = [];
  let props: Prop[] | null = null;
  let index = 0;
  for (const raw of unfold(stripBom(text))) {
    const prop = parseProp(raw);
    if (prop === null) continue;
    if (prop.name === 'BEGIN' && prop.value.trim().toUpperCase() === 'VCARD') {
      if (props !== null) rows.push(cardRow(index, props));
      index += 1;
      props = [];
    } else if (prop.name === 'END' && prop.value.trim().toUpperCase() === 'VCARD') {
      if (props !== null) rows.push(cardRow(index, props));
      props = null;
    } else if (props !== null) {
      props.push(prop);
    }
  }
  if (props !== null) rows.push(cardRow(index, props));
  if (index === 0) throw new UnsupportedFormat('no BEGIN:VCARD');
  return rows;
}

// ------------------------------------------------------------------ CSV

/** `;` when the first record (outside quotes) has more `;` than `,`, otherwise `,`. */
function detectDelimiter(text: string): ';' | ',' {
  let inQuotes = false;
  let semicolons = 0;
  let commas = 0;
  for (const ch of text) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes) {
      if (ch === '\n' || ch === '\r') break;
      if (ch === ';') semicolons += 1;
      else if (ch === ',') commas += 1;
    }
  }
  return semicolons > commas ? ';' : ',';
}

function splitRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;
  let pending = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
      pending = true;
    } else if (ch === delimiter) {
      record.push(field);
      field = '';
      pending = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      pending = false;
    } else {
      field += ch;
      pending = true;
    }
  }
  if (pending || field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

const padTo = (cells: string[], width: number): string[] =>
  cells.length >= width ? cells : [...cells, ...Array<string>(width - cells.length).fill('')];

/**
 * Upload limit on data rows, enforced by the import routes. The parsers keep at most
 * `MAX_IMPORT_ROWS + 1` rows so the caller can tell "too large" without an unbounded table.
 */
export const MAX_IMPORT_ROWS = 5000;
const ROW_CAP = MAX_IMPORT_ROWS + 1;

/** Builds a table from records; `line` is the record's number in the file (header = 1). */
function tableFrom(records: string[][]): ImportTable {
  if (records.length === 0) return { headers: [], rows: [] };
  const headers = records[0]!.map((h) => h.trim());
  const rows: ImportTable['rows'] = [];
  for (let i = 1; i < records.length && rows.length < ROW_CAP; i++) {
    const cells = records[i]!;
    if (cells.every((c) => c.trim() === '')) continue;
    rows.push({ line: i + 1, cells: padTo(cells, headers.length) });
  }
  return { headers, rows };
}

export function parseCsv(bytes: Uint8Array): ImportTable {
  const text = decodeText(bytes);
  return tableFrom(splitRecords(text, detectDelimiter(text)));
}

// ----------------------------------------------------------------- XLSX

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (Array.isArray(v.richText)) {
      return v.richText.map((part) => String((part as { text?: unknown }).text ?? '')).join('');
    }
    if ('formula' in v || 'sharedFormula' in v) return cellText(v.result);
    if ('hyperlink' in v) return cellText(v.text);
    if ('error' in v) return '';
  }
  return '';
}

export async function parseXlsx(bytes: Uint8Array): Promise<ImportTable> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) as never);
  } catch (e) {
    throw new UnsupportedFormat(`cannot open XLSX: ${e instanceof Error ? e.message : String(e)}`);
  }
  const sheet = workbook.worksheets[0];
  if (sheet === undefined) return { headers: [], rows: [] };
  // Only non-empty rows and cells are visited: a stray cell far down the sheet must stay cheap.
  const headers: string[] = [];
  const rows: ImportTable['rows'] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) {
      row.eachCell({ includeEmpty: false }, (cell, col) => {
        while (headers.length < col) headers.push('');
        headers[col - 1] = cellText(cell.value).trim();
      });
      return;
    }
    if (headers.length === 0 || rows.length >= ROW_CAP) return;
    const cells: string[] = Array<string>(headers.length).fill('');
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      if (col <= headers.length) cells[col - 1] = cellText(cell.value);
    });
    if (cells.every((c) => c.trim() === '')) return;
    rows.push({ line: rowNumber, cells });
  });
  return { headers, rows };
}

import ExcelJS from 'exceljs';
import { describe, expect, test } from 'vitest';
import { parseCsv, parseImportFile, parseVcard, parseXlsx, UnsupportedFormat } from '../src/import/parse.js';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

const PL = 'ąćęłńóśźżĄĆĘŁŃÓŚŹŻ';
const CP1250 = [0xb9, 0xe6, 0xea, 0xb3, 0xf1, 0xf3, 0x9c, 0x9f, 0xbf, 0xa5, 0xc6, 0xca, 0xa3, 0xd1, 0xd3, 0x8c, 0x8f, 0xaf];
const encodeWindows1250 = (text: string): Uint8Array =>
  Uint8Array.from([...text].map((ch) => {
    const i = PL.indexOf(ch);
    return i >= 0 ? CP1250[i]! : ch.charCodeAt(0);
  }));

async function xlsxBytes(): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Kontakty');
  ws.addRow(['Imię', 'Data', 'Liczba', 'Suma', 'Opis']);
  ws.addRow(['Anna', new Date(Date.UTC(2026, 9, 31)), 42, { formula: 'C2*2', result: 84 }, { richText: [{ text: 'a' }, { text: 'b' }] }]);
  ws.addRow([]);
  ws.addRow(['Piotr', null, 1.5]);
  wb.addWorksheet('Drugi').addRow(['ignored']);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

describe('parseVcard', () => {
  test('vCard 3.0 from a phone', () => {
    const vcf = ['BEGIN:VCARD', 'VERSION:3.0', 'N:Nowak;Anna;;;', 'FN:Anna Nowak', 'TEL;TYPE=CELL:+48 600 100 200',
      'item1.EMAIL;TYPE=INTERNET:anna@firma-x.pl', 'ORG:Firma X Sp. z o.o.;Księgowość', 'TITLE:Główna księgowa',
      'NOTE:Dzwonić po 10\\, nie w piątki\\nTel. biuro', '  wewn. 21', 'END:VCARD'].join('\r\n');
    expect(parseVcard(vcf)).toEqual([{
      line: 1, contact: { title: 'Anna Nowak', data: { notes: 'Dzwonić po 10, nie w piątki\nTel. biuro wewn. 21' } },
      identities: [{ channel: 'phone', address: '+48 600 100 200' }, { channel: 'email', address: 'anna@firma-x.pl' }],
      organization: { title: 'Firma X Sp. z o.o.', nip: null, data: {} }, membership: { role: [], position: 'Główna księgowa' },
    }]);
  });

  test('vCard 4.0 without FN uses N; several cards get lines 1, 2', () => {
    const vcf = ['BEGIN:VCARD', 'VERSION:4.0', 'N:Kowalski;Jan;;;', 'TEL;VALUE=uri:tel:+48500', 'TEL:+48501', 'END:VCARD',
      'BEGIN:VCARD', 'VERSION:4.0', 'FN:Beta\\; Co', 'EMAIL:b@x.pl', 'END:VCARD'].join('\n');
    const rows = parseVcard(vcf);
    expect(rows.map((r) => r.line)).toEqual([1, 2]);
    expect(rows[0]!.contact.title).toBe('Jan Kowalski');
    expect(rows[0]!.identities.map((i) => i.channel)).toEqual(['phone', 'phone']);
    expect(rows[0]!.organization).toBeNull();
    expect(rows[0]!.membership).toBeNull();
    expect(rows[1]!.contact.title).toBe('Beta; Co');
    expect(rows[1]!.contact.data).toEqual({});
  });

  test('a tab continues a folded line; without BEGIN:VCARD is unsupported', () => {
    const rows = parseVcard('BEGIN:VCARD\r\nFN:Ab\r\n\tcd\r\nEND:VCARD');
    expect(rows[0]!.contact.title).toBe('Abcd');
    expect(() => parseVcard('FN:x')).toThrow(UnsupportedFormat);
  });
});

describe('parseCsv', () => {
  test('CSV from Polish Excel: Windows-1250, semicolons, quotes', () => {
    const text = 'Imię;Nazwisko;Miasto;Uwagi\r\nAnna;Nowak;Łódź;"a; b ""c"""\r\n;;;\r\n';
    expect(parseCsv(encodeWindows1250(text))).toEqual({
      headers: ['Imię', 'Nazwisko', 'Miasto', 'Uwagi'],
      rows: [{ line: 2, cells: ['Anna', 'Nowak', 'Łódź', 'a; b "c"'] }],
    });
  });

  test('CSV in UTF-8 with BOM and commas', () => {
    const text = '\uFEFF Name , Email\nAnna,a@x.pl\n\nPiotr,"p@x.pl"\n';
    expect(parseCsv(utf8(text))).toEqual({
      headers: ['Name', 'Email'],
      rows: [{ line: 2, cells: ['Anna', 'a@x.pl'] }, { line: 4, cells: ['Piotr', 'p@x.pl'] }],
    });
  });

  test('newline inside quotes keeps one row; later rows count records, as Excel does', () => {
    const t = parseCsv(utf8('A;B\n"x\ny";1\nz;2'));
    expect(t.rows).toEqual([{ line: 2, cells: ['x\ny', '1'] }, { line: 3, cells: ['z', '2'] }]);
  });

  test('separator is picked outside quotes on the first line', () => {
    expect(parseCsv(utf8('"a;b;c",d\n1,2')).headers).toEqual(['a;b;c', 'd']);
  });
});

describe('parseXlsx', () => {
  test('XLSX first sheet with a date, a number, a formula and rich text', async () => {
    expect(await parseXlsx(await xlsxBytes())).toEqual({
      headers: ['Imię', 'Data', 'Liczba', 'Suma', 'Opis'],
      rows: [
        { line: 2, cells: ['Anna', '2026-10-31', '42', '84', 'ab'] },
        { line: 4, cells: ['Piotr', '', '1.5', '', ''] },
      ],
    });
  });
});

describe('parseImportFile', () => {
  test('format detection and unsupported input', async () => {
    expect((await parseImportFile(utf8('BEGIN:VCARD\r\nFN:A\r\nEND:VCARD'))).kind).toBe('vcard');
    expect((await parseImportFile(utf8('\uFEFF\r\n  begin:vcard\r\nFN:A\r\nEND:VCARD'))).kind).toBe('vcard');
    expect((await parseImportFile(await xlsxBytes())).kind).toBe('table');
    expect((await parseImportFile(utf8('Imię;Tel\r\nAnna;1'))).kind).toBe('table');
    await expect(parseImportFile(new Uint8Array([0, 0, 0, 0]))).rejects.toBeInstanceOf(UnsupportedFormat);
    await expect(parseImportFile(new Uint8Array([1, 2, 0, 3, 4]))).rejects.toBeInstanceOf(UnsupportedFormat);
    await expect(parseImportFile(utf8(''))).rejects.toBeInstanceOf(UnsupportedFormat);
    await expect(parseImportFile(utf8(';;;\n1;2;3'))).rejects.toBeInstanceOf(UnsupportedFormat);
  });

  test('corrupt XLSX is unsupported', async () => {
    const bad = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5]);
    await expect(parseImportFile(bad)).rejects.toBeInstanceOf(UnsupportedFormat);
  });
});

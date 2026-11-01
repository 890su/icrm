import { fileURLToPath } from 'node:url';
import { loadConfigDir } from '@icrm/core/node';
import { freshDb } from '@icrm/db/testing';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildServer } from '../src/server.js';

const TOKEN = 'test-token-0123456789';
const fixture = (...p: string[]): string => fileURLToPath(new URL(['fixtures', ...p].join('/'), import.meta.url));
const BOUNDARY = '----icrmtestboundary7MA4YWxkTrZu0gW';

let app: FastifyInstance;

beforeAll(async () => {
  const fresh = await freshDb();
  const cfg = await loadConfigDir(fixture('contacts'));
  app = buildServer({
    db: fresh.db, cfg, workspaceId: fresh.workspaceId, systemUserId: fresh.userId, apiToken: TOKEN,
    now: () => new Date('2026-10-31T10:00:00Z'),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

type Part = { name: string; value: string | Buffer; filename?: string };

/** A `multipart/form-data` body: text parts, and file parts when a `filename` is given. */
function multipart(parts: Part[]): { payload: Buffer; headers: Record<string, string> } {
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const disposition = `form-data; name="${p.name}"${p.filename === undefined ? '' : `; filename="${p.filename}"`}`;
    const type = p.filename === undefined ? '' : '\r\nContent-Type: application/octet-stream';
    chunks.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: ${disposition}${type}\r\n\r\n`), Buffer.from(p.value), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
  };
}

const post = (url: string, parts: Part[]): Promise<LightMyRequestResponse> => {
  const { payload, headers } = multipart(parts);
  return app.inject({ method: 'POST', url, payload, headers });
};

const file = (content: string | Buffer, filename = 'contacts.csv'): Part => ({ name: 'file', value: content, filename });
const mapping = (m: unknown): Part => ({ name: 'mapping', value: typeof m === 'string' ? m : JSON.stringify(m) });

const CSV = 'Имя,Почта,Телефон\nAnna Kowalska,anna@firma.pl,600 100 200\nJan Nowak,jan@firma.pl,\n';
const MAP = { Имя: 'contact.title', Почта: 'identity.email', Телефон: 'identity.phone' };

describe('POST /import/preview and /import/commit', () => {
  test('preview and commit a CSV over HTTP', async () => {
    const preview = await post('/import/preview', [file(CSV), mapping(MAP)]);
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().rows).toEqual([
      expect.objectContaining({ line: 2, action: 'create', warnings: [] }),
      expect.objectContaining({ line: 3, action: 'create', warnings: [] }),
    ]);
    // a preview writes nothing
    expect((await post('/import/preview', [file(CSV), mapping(MAP)])).json().rows[0].action).toBe('create');

    const commit = await post('/import/commit', [file(CSV), mapping(MAP)]);
    expect(commit.statusCode, commit.body).toBe(200);
    const created = commit.json().rows as { action: string; contactId: string }[];
    expect(created.map((r) => r.action)).toEqual(['create', 'create']);
    expect(created[0]!.contactId).toEqual(expect.any(String));

    const again = await post('/import/commit', [file(CSV), mapping(MAP)]);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().rows.map((r: { action: string }) => r.action)).toEqual(['update', 'update']);
    expect(again.json().rows[0].contactId).toBe(created[0]!.contactId);

    const found = await app.inject({
      method: 'GET', url: '/identities?q=anna@firma.pl', headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(found.json().items).toHaveLength(1);
  });

  test('the mapping part may come before the file part', async () => {
    const r = await post('/import/preview', [mapping(MAP), file(CSV)]);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().rows).toHaveLength(2);
  });

  test('vCard needs no mapping', async () => {
    const vcf = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Piotr Zieliński\r\nEMAIL:piotr@vcard.pl\r\nTEL:+48 601 000 111\r\nEND:VCARD\r\n';
    const preview = await post('/import/preview', [file(vcf, 'contacts.vcf')]);
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().rows).toEqual([expect.objectContaining({ line: 1, action: 'create' })]);
    // a mapping sent with a vCard is ignored, even a broken one
    const ignored = await post('/import/commit', [file(vcf, 'contacts.vcf'), mapping('not json')]);
    expect(ignored.statusCode, ignored.body).toBe(200);
    expect(ignored.json().rows).toEqual([expect.objectContaining({ action: 'create', contactId: expect.any(String) })]);
  });

  test('too large file and too many rows → 413 import_too_large', async () => {
    for (const url of ['/import/preview', '/import/commit']) {
      const big = await post(url, [file(Buffer.alloc(5 * 1024 * 1024 + 1, 'a')), mapping(MAP)]);
      expect(big.statusCode, big.body).toBe(413);
      expect(big.json().errors).toEqual([expect.objectContaining({ code: 'import_too_large' })]);
    }
    const many = ['N', ...Array.from({ length: 5001 }, (_, i) => `Person ${i}`)].join('\n');
    for (const url of ['/import/preview', '/import/commit']) {
      const r = await post(url, [file(many), mapping({ N: 'contact.title' })]);
      expect(r.statusCode, r.body).toBe(413);
      expect(r.json().errors).toEqual([expect.objectContaining({ code: 'import_too_large' })]);
    }
    // exactly 5000 rows is accepted
    const ok = ['N', ...Array.from({ length: 5000 }, (_, i) => `Person ${i}`)].join('\n');
    const r = await post('/import/preview', [file(ok), mapping({ N: 'contact.title' })]);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().rows).toHaveLength(5000);
  });

  test('missing file, bad mapping JSON, unsupported format → 400; unknown target → 422', async () => {
    const code = (r: LightMyRequestResponse): string => r.json().errors[0].code;

    const noFile = await post('/import/preview', [mapping(MAP)]);
    expect(noFile.statusCode).toBe(400);
    expect(code(noFile)).toBe('bad_request');

    const noMapping = await post('/import/preview', [file(CSV)]);
    expect(noMapping.statusCode).toBe(400);
    expect(code(noMapping)).toBe('bad_request');

    for (const bad of ['{nope', '[1,2]', '"x"', '{"Имя":5}']) {
      const r = await post('/import/preview', [file(CSV), mapping(bad)]);
      expect(r.statusCode, bad).toBe(400);
      expect(code(r)).toBe('bad_request');
    }

    const binary = await post('/import/preview', [file(Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]), 'x.bin'), mapping(MAP)]);
    expect(binary.statusCode).toBe(400);
    expect(code(binary)).toBe('bad_request');

    const notMultipart = await app.inject({
      method: 'POST', url: '/import/preview', payload: { a: 1 }, headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(notMultipart.statusCode).toBe(400);
    expect(code(notMultipart)).toBe('bad_request');

    const unknown = await post('/import/preview', [file(CSV), mapping({ ...MAP, Имя: 'contact.nothing' })]);
    expect(unknown.statusCode, unknown.body).toBe(422);
    expect(unknown.json().errors).toEqual([expect.objectContaining({ code: 'invalid_value', field: 'mapping.Имя' })]);
    const missingColumn = await post('/import/commit', [file(CSV), mapping({ Нет: 'contact.title' })]);
    expect(missingColumn.statusCode).toBe(422);
  });

  test('requires the bearer token', async () => {
    const { payload, headers } = multipart([file(CSV), mapping(MAP)]);
    const r = await app.inject({ method: 'POST', url: '/import/preview', payload, headers: { 'content-type': headers['content-type']! } });
    expect(r.statusCode).toBe(401);
  });
});

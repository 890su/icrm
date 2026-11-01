import type { ImportMapping, ImportRow, ImportService } from '@icrm/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { badRequestBody, tooLargeBody } from '../errors.js';
import { MAX_IMPORT_ROWS, parseImportFile, UnsupportedFormat } from '../import/parse.js';

/** Largest accepted upload; the file is read into memory and never stored. */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

const mappingSchema = z.record(z.string(), z.string());

interface Upload {
  file: Buffer | null;
  /** The raw `mapping` field, `null` when the request had none. */
  mapping: string | null;
}

/** Reads the `file` and `mapping` parts, in whatever order they come; a file over the limit throws (see errors.ts). */
async function readUpload(req: FastifyRequest): Promise<Upload> {
  const upload: Upload = { file: null, mapping: null };
  for await (const part of req.parts()) {
    if (part.type === 'file') {
      // The stream must be drained either way; only the part called `file` is used.
      const bytes = await part.toBuffer();
      if (part.fieldname === 'file' && upload.file === null) upload.file = bytes;
    } else if (part.fieldname === 'mapping' && typeof part.value === 'string') {
      upload.mapping = part.value;
    }
  }
  return upload;
}

function parseMapping(raw: string | null): ImportMapping | string {
  if (raw === null) return 'Для CSV и XLSX нужно поле mapping — JSON «заголовок колонки → поле»';
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return 'Поле mapping не является корректным JSON';
  }
  const parsed = mappingSchema.safeParse(json);
  return parsed.success ? parsed.data : 'Поле mapping должно быть объектом «заголовок колонки → поле»';
}

/**
 * The rows of an uploaded file: a vCard needs no mapping, a table gets its rows from the mapping.
 * Sends the error reply and returns `null` when there are none to use.
 */
async function rowsOf(o: { imports: ImportService }, req: FastifyRequest, reply: FastifyReply): Promise<ImportRow[] | null> {
  if (!req.isMultipart()) {
    await reply.code(400).send(badRequestBody('Ожидается multipart/form-data с полями file и mapping'));
    return null;
  }
  const upload = await readUpload(req);
  if (upload.file === null) {
    await reply.code(400).send(badRequestBody('Не передан файл (поле file)'));
    return null;
  }
  let rows: ImportRow[];
  try {
    const parsed = await parseImportFile(upload.file);
    if (parsed.kind === 'vcard') {
      rows = parsed.rows;
    } else {
      if (parsed.table.rows.length > MAX_IMPORT_ROWS) {
        await reply.code(413).send(tooLargeBody(`В файле больше ${MAX_IMPORT_ROWS} строк`));
        return null;
      }
      const mapping = parseMapping(upload.mapping);
      if (typeof mapping === 'string') {
        await reply.code(400).send(badRequestBody(mapping));
        return null;
      }
      const mapped = o.imports.rowsFromTable(parsed.table, mapping);
      if (!mapped.ok) {
        await reply.code(422).send({ errors: mapped.errors });
        return null;
      }
      rows = mapped.rows;
    }
  } catch (e) {
    if (e instanceof UnsupportedFormat) {
      await reply.code(400).send(badRequestBody('Файл не похож на vCard, CSV или XLSX с заголовками'));
      return null;
    }
    throw e;
  }
  if (rows.length > MAX_IMPORT_ROWS) {
    await reply.code(413).send(tooLargeBody(`В файле больше ${MAX_IMPORT_ROWS} строк`));
    return null;
  }
  return rows;
}

/** Import of contacts from a vCard, CSV or XLSX file (spec 2b §7.3): a dry run and the real thing. */
export function registerImportRoutes(app: FastifyInstance, o: { imports: ImportService; systemUserId: string }): void {
  app.post('/import/preview', async (req, reply) => {
    const rows = await rowsOf(o, req, reply);
    return rows === null ? reply : { rows: await o.imports.preview(rows) };
  });

  app.post('/import/commit', async (req, reply) => {
    const rows = await rowsOf(o, req, reply);
    return rows === null ? reply : { rows: await o.imports.commit(rows, o.systemUserId) };
  });
}

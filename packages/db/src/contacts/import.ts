import { todayIn, type CompiledConfig, type RecordError, type Value } from '@icrm/core';
import type { Kysely } from 'kysely';
import type { DB } from '../schema.js';
import { recordError } from '../service/errors.js';
import type { RecordService, TxOps } from '../service/record-service.js';
import type { IdentityService } from './identities.js';
import { importableField, isVirtual, Overlay, planRow, type PlanDeps, type RowPlan } from './import-plan.js';

/** A parsed spreadsheet-like file: headers plus non-empty rows (`line` is the file's row number, header = 1). */
export interface ImportTable {
  headers: string[];
  rows: { line: number; cells: string[] }[];
}

/** One contact to import, with its optional organization and membership (raw cell values, not yet normalised). */
export interface ImportRow {
  line: number;
  contact: { title: string | null; data: Record<string, string> };
  identities: { channel: string; address: string }[];
  organization: { title: string | null; nip: string | null; data: Record<string, string> } | null;
  membership: { role: string[]; position: string | null } | null;
  /** The file's column of each `contact.<f>` / `organization.<f>` / `membership.role` target, so that warnings can name it. */
  columns?: Record<string, string>;
}

/**
 * What a column of a table imports into: `skip`, `contact.title`, `contact.<f>`, `identity.email|phone|telegram`,
 * `organization.title`, `organization.nip`, `organization.<f>`, `membership.role`, `membership.position`.
 */
export type ImportTarget = string;
/** Header of a column → its target; columns without one are skipped. */
export type ImportMapping = Record<string, ImportTarget>;
export type RowAction = 'create' | 'update' | 'skip' | 'error';

/** The outcome of one row of an import (spec 2b §7.3); ids are given for records that exist. */
export interface RowResult {
  line: number;
  action: RowAction;
  reason?: 'ambiguous_match' | 'empty_row';
  contactId?: string;
  organization?: { action: 'found' | 'create'; id?: string } | null;
  membership?: 'create' | 'exists' | null;
  warnings: string[];
  errors?: RecordError[];
}

export type MappingResult = { ok: true; rows: ImportRow[] } | { ok: false; errors: RecordError[] };

const FIXED_TARGETS: ReadonlySet<string> = new Set([
  'skip', 'contact.title', 'identity.email', 'identity.phone', 'identity.telegram',
  'organization.title', 'organization.nip', 'membership.role', 'membership.position',
]);

/** Targets several columns may share: names are joined, addresses and roles are collected. */
const repeatable = (t: string): boolean => t === 'contact.title' || t.startsWith('identity.') || t === 'membership.role';

const mappingError = (header: string, message: string): RecordError =>
  recordError('invalid_value', message, { field: `mapping.${header}` });

/**
 * Import of contacts (spec 2b §7.3): a table is turned into rows by a column mapping; `preview` plans every
 * row without writing, each seeing what the earlier rows would create; `commit` re-plans each row against
 * the database and carries it out in its own transaction, so a failing row does not stop the others.
 * Both use the one row planner of `import-plan.ts`.
 */
export class ImportService {
  private readonly db: Kysely<DB>;
  private readonly cfg: CompiledConfig;
  private readonly workspaceId: string;
  private readonly now: () => Date;
  private readonly records: RecordService;
  private readonly identities: IdentityService;

  constructor(o: {
    db: Kysely<DB>; cfg: CompiledConfig; workspaceId: string; now?: () => Date;
    records: RecordService; identities: IdentityService;
  }) {
    this.db = o.db;
    this.cfg = o.cfg;
    this.workspaceId = o.workspaceId;
    this.now = o.now ?? (() => new Date());
    this.records = o.records;
    this.identities = o.identities;
  }

  /**
   * The rows of `table` under `mapping`. Errors (`invalid_value` at `mapping.<header>`): a mapped header that
   * is not in the file or appears in it more than once, an unknown or not importable target, a target other
   * than a name, address or role given to two columns. Several name columns are joined with a space in
   * column order; cells beyond the headers are ignored; empty cells are no value.
   */
  rowsFromTable(table: ImportTable, mapping: ImportMapping): MappingResult {
    const errors: RecordError[] = [];
    const targetOf = (h: string): string | undefined => (Object.hasOwn(mapping, h) ? mapping[h] : undefined);
    for (const h of Object.keys(mapping)) {
      if (!table.headers.includes(h)) errors.push(mappingError(h, `Колонки «${h}» нет в файле`));
    }
    const columns: { index: number; header: string; target: string }[] = [];
    const usedBy = new Map<string, string>();
    table.headers.forEach((header, index) => {
      const target = targetOf(header);
      if (target === undefined || table.headers.indexOf(header) !== index) return;
      if (table.headers.lastIndexOf(header) !== index) {
        if (target !== 'skip') errors.push(mappingError(header, `Заголовок «${header}» повторяется в файле`));
        return;
      }
      if (typeof target !== 'string' || !this.knownTarget(target)) {
        errors.push(mappingError(header, `Колонку «${header}» нельзя импортировать в «${String(target)}»`));
        return;
      }
      if (target === 'skip') return;
      const prev = usedBy.get(target);
      if (prev !== undefined && !repeatable(target)) {
        errors.push(mappingError(header, `«${target}» уже назначено колонке «${prev}»`));
        return;
      }
      usedBy.set(target, header);
      columns.push({ index, header, target });
    });
    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, rows: table.rows.map((r) => this.rowOf(r, columns)) };
  }

  /** Plans every row without writing; each row sees what the rows before it would create. */
  async preview(rows: ImportRow[]): Promise<RowResult[]> {
    const deps = this.deps();
    const overlay = new Overlay();
    const out: RowResult[] = [];
    for (const row of rows) {
      const plan = await planRow(this.db, deps, row, overlay);
      overlay.apply(plan);
      out.push(previewResult(plan));
    }
    return out;
  }

  /**
   * Imports the rows one by one, each re-planned against the database and carried out in one transaction
   * (contact, new addresses, organization, membership). A row whose save fails is `error` with its errors
   * and leaves nothing behind; the rows after it go on.
   */
  async commit(rows: ImportRow[], userId: string): Promise<RowResult[]> {
    const out: RowResult[] = [];
    for (const row of rows) {
      let plan: RowPlan | undefined;
      const res = await this.records.transaction(userId, async (ops) => {
        plan = await planRow(ops.tx, this.deps(), row, new Overlay());
        return this.execute(ops, plan, userId);
      });
      out.push(res.ok ? res.value : { line: row.line, action: 'error', warnings: plan?.warnings ?? [], errors: res.errors });
    }
    return out;
  }

  private deps(): PlanDeps {
    return { cfg: this.cfg, workspaceId: this.workspaceId, today: todayIn(this.now(), this.cfg.timezone) };
  }

  private knownTarget(target: string): boolean {
    if (FIXED_TARGETS.has(target)) return true;
    const dot = target.indexOf('.');
    const set = target.slice(0, dot);
    if (set !== 'contact' && set !== 'organization') return false;
    return importableField(this.cfg, set, target.slice(dot + 1)) !== null;
  }

  private rowOf(r: ImportTable['rows'][number], columns: { index: number; header: string; target: string }[]): ImportRow {
    const names: string[] = [];
    const contactData: Record<string, string> = {};
    const identities: ImportRow['identities'] = [];
    const org = { title: null as string | null, nip: null as string | null, data: {} as Record<string, string> };
    const role: string[] = [];
    let position: string | null = null;
    const used: Record<string, string> = {};
    for (const { index, header, target } of columns) {
      const cell = r.cells[index] ?? '';
      const value = cell.trim();
      if (value === '') continue;
      const [set, key = ''] = [target.slice(0, target.indexOf('.')), target.slice(target.indexOf('.') + 1)];
      if (target === 'contact.title') names.push(value);
      else if (set === 'identity') identities.push({ channel: key, address: value });
      else if (target === 'organization.title') org.title = value;
      else if (target === 'organization.nip') org.nip = value;
      else if (target === 'membership.role') {
        role.push(...value.split(/[,;]/).map((s) => s.trim()).filter((s) => s !== ''));
        used[target] = used[target] === undefined ? header : `${used[target]}», «${header}`;
      }
      else if (target === 'membership.position') position = value;
      else {
        (set === 'contact' ? contactData : org.data)[key] = cell;
        used[target] = header;
      }
    }
    const hasOrg = org.title !== null || org.nip !== null || Object.keys(org.data).length > 0;
    return {
      line: r.line,
      contact: { title: names.length > 0 ? names.join(' ') : null, data: contactData },
      identities,
      organization: hasOrg ? org : null,
      membership: role.length > 0 || position !== null ? { role, position } : null,
      ...(Object.keys(used).length > 0 ? { columns: used } : {}),
    };
  }

  /** Carries out a plan inside the row's transaction; a failing save throws and rolls the row back. */
  private async execute(ops: TxOps, plan: RowPlan, userId: string): Promise<RowResult> {
    if (plan.action === 'skip' || plan.contact === null) return previewResult(plan);
    const c = plan.contact;
    let contactId: string;
    if (plan.action === 'create') {
      contactId = (await ops.create({ userId, title: c.title ?? '', sets: ['contact'], data: c.data })).id;
    } else {
      contactId = c.ref;
      if (c.title !== null || Object.keys(c.data).length > 0) {
        await ops.update({
          id: contactId, userId, expectedVersion: c.version ?? 0, data: c.data, ...(c.title === null ? {} : { title: c.title }),
        });
      }
    }
    for (const a of plan.addresses) {
      await this.identities.addIn(ops.tx, { ownerId: contactId, channel: a.channel, address: a.display, userId });
    }

    let organization: RowResult['organization'] = null;
    const o = plan.organization;
    if (o !== null) {
      const id = o.action === 'found' ? o.ref
        : (await ops.create({ userId, title: o.title, sets: ['organization'], data: o.data })).id;
      organization = { action: o.action, id };
      if (plan.membership?.action === 'create') {
        const data: Record<string, Value> = {};
        if (plan.membership.role.length > 0) data.role = plan.membership.role;
        if (plan.membership.position !== null) data.position = plan.membership.position;
        await ops.create({ userId, title: '', sets: ['membership'], data, links: { contact: [contactId], organization: [id] } });
      }
    }
    return {
      line: plan.line, action: plan.action, contactId, organization,
      membership: plan.membership?.action ?? null, warnings: plan.warnings,
    };
  }
}

/** The result of a plan as a preview reports it: ids only of records that exist. */
function previewResult(plan: RowPlan): RowResult {
  const real = (ref: string): { id: string } | object => (isVirtual(ref) ? {} : { id: ref });
  const out: RowResult = { line: plan.line, action: plan.action, warnings: plan.warnings };
  if (plan.reason !== undefined) out.reason = plan.reason;
  if (plan.contact !== null && !isVirtual(plan.contact.ref)) out.contactId = plan.contact.ref;
  out.organization = plan.organization === null ? null : { action: plan.organization.action, ...real(plan.organization.ref) };
  out.membership = plan.membership?.action ?? null;
  return out;
}

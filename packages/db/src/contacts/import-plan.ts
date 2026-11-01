import {
  coerceCell, identityChannel, isEmpty, normalizeAddress, normalizeCompanyName, normalizeNip,
  type Channel, type CompiledConfig, type CompiledField, type Value,
} from '@icrm/core';
import { liveByAddress } from '../repo/identities.js';
import { linksFrom } from '../repo/links.js';
import { organizationByNip, organizationsByName } from '../repo/organizations.js';
import { loadRecords } from '../repo/records.js';
import type { Db } from '../repo/types.js';
import type { ImportRow } from './import.js';
import { membershipsOf } from './memberships.js';

/** Field types a cell can fill (spec 2b §7.3, `coerceCell`). */
const CELL_TYPES: ReadonlySet<string> = new Set(['text', 'number', 'date', 'bool', 'enum']);

/**
 * The field `key` of set `set` that an import may fill: a field of the set (with `extend`) of a cell type,
 * not `managed`. The organization's `nip` is not one: it is the match key with its own target.
 */
export function importableField(cfg: CompiledConfig, set: 'contact' | 'organization', key: string): CompiledField | null {
  if (set === 'organization' && key === 'nip') return null;
  const s = cfg.sets.get(set);
  const f = cfg.fields.get(key);
  if (s === undefined || f === undefined || !s.fields.includes(key)) return null;
  return f.managed === true || !CELL_TYPES.has(f.type) ? null : f;
}

/** An organization matched by name: its id (or virtual ref), title and NIP. */
interface NamedOrganization { id: string; title: string; nip: string | null }

/** A normalised address of a row. */
export interface PlannedAddress { channel: Channel; normalized: string; display: string }

/**
 * What one row will do (spec 2b §7.3). `ref`s are record ids, or virtual ones (`Overlay.newRef`) for
 * records that this row (or, in a preview, an earlier one) creates.
 */
export interface RowPlan {
  line: number;
  action: 'create' | 'update' | 'skip';
  reason?: 'ambiguous_match' | 'empty_row';
  warnings: string[];
  /** For create: the title and values; for update: only what fills empty fields (`title` null — keep). */
  contact: {
    ref: string; version: number | null; title: string | null; data: Record<string, Value>;
    /** The contact as it is after the row. */
    after: { title: string; data: Record<string, Value> };
  } | null;
  /** The row's addresses nobody has yet: added to the contact. */
  addresses: PlannedAddress[];
  organization: { action: 'found'; ref: string } | {
    action: 'create'; ref: string; title: string; data: Record<string, Value>; nip: string | null; nameNorm: string;
  } | null;
  membership: { action: 'create'; role: string[]; position: string | null } | { action: 'exists' } | null;
}

const VIRTUAL = 'new:';

/** A ref of a record that does not exist yet. */
export const isVirtual = (ref: string): boolean => ref.startsWith(VIRTUAL);

/**
 * What the earlier rows of a previewed file would have created or changed, consulted before the database so
 * that a preview sees the file as a commit would. A commit plans each row with an empty one.
 */
export class Overlay {
  private seq = 0;
  /** Contacts created or updated by earlier rows, by ref. */
  readonly contacts = new Map<string, { title: string; data: Record<string, Value> }>();
  /** `channel:address` → contact ref. */
  readonly addresses = new Map<string, string>();
  /** NIP → organization ref. */
  readonly nips = new Map<string, string>();
  /** Normalised name → the organizations created under it, with their NIPs. */
  readonly names = new Map<string, NamedOrganization[]>();
  /** `contactRef organizationRef` of the memberships created by earlier rows. */
  readonly pairs = new Set<string>();

  newRef(): string {
    this.seq += 1;
    return `${VIRTUAL}${this.seq}`;
  }

  /** Records what `plan` creates and changes, for the rows after it. */
  apply(plan: RowPlan): void {
    if (plan.contact === null) return;
    const contactRef = plan.contact.ref;
    this.contacts.set(contactRef, plan.contact.after);
    for (const a of plan.addresses) this.addresses.set(addressKey(a.channel, a.normalized), contactRef);
    const org = plan.organization;
    if (org?.action === 'create') {
      if (org.nip !== null) this.nips.set(org.nip, org.ref);
      if (org.nameNorm !== '') {
        this.names.set(org.nameNorm, [...(this.names.get(org.nameNorm) ?? []), { id: org.ref, title: org.title, nip: org.nip }]);
      }
    }
    if (org !== null && plan.membership?.action === 'create') this.pairs.add(pairKey(contactRef, org.ref));
  }
}

const addressKey = (channel: Channel, normalized: string): string => `${channel}:${normalized}`;
const pairKey = (contactRef: string, organizationRef: string): string => `${contactRef} ${organizationRef}`;
const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);
const trimmed = (s: string | null | undefined): string | null => {
  const t = s?.trim() ?? '';
  return t === '' ? null : t;
};

/** Who an address of the row leads to: a contact, nobody, or nobody with a warning (the address is skipped). */
type Holder = { kind: 'contact'; ref: string } | { kind: 'none' } | { kind: 'skip'; warning: string };

export interface PlanDeps {
  cfg: CompiledConfig;
  workspaceId: string;
  /** The workspace date ("YYYY-MM-DD") for judging memberships active. */
  today: string;
}

/**
 * Plans one row by reads only (spec 2b §7.3): the overlay first, then `tx`. Addresses are normalised
 * (unreadable ones are warnings); the contact is matched by any address (an address of an organization is
 * not a person, one of a membership is its contact's); several contacts → `ambiguous_match`; one → update
 * of empty fields and new addresses; none → create when there is a name or an address, else `empty_row`.
 * The organization is found by NIP, then by exact normalised name, else created (never updated); the
 * membership is created when the pair has no active one.
 */
export async function planRow(tx: Db, deps: PlanDeps, row: ImportRow, overlay: Overlay): Promise<RowPlan> {
  const warnings: string[] = [];
  const base = { line: row.line, warnings, addresses: [], contact: null, organization: null, membership: null };

  const addresses = parseAddresses(deps.cfg, row, warnings);
  const matched = new Set<string>();
  const fresh: PlannedAddress[] = [];
  for (const a of addresses) {
    const holder = await holderOf(tx, deps.workspaceId, a, overlay);
    if (holder.kind === 'contact') matched.add(holder.ref);
    else if (holder.kind === 'skip') warnings.push(holder.warning);
    else fresh.push(a);
  }
  if (matched.size > 1) return { ...base, action: 'skip', reason: 'ambiguous_match' };

  const title = trimmed(row.contact.title);
  const values = coerceAll(deps.cfg, 'contact', row.contact.data, row.columns, warnings);
  let action: 'create' | 'update';
  let contact: NonNullable<RowPlan['contact']>;
  const [matchedRef] = matched;
  if (matchedRef !== undefined) {
    action = 'update';
    contact = await updateOf(tx, deps.workspaceId, matchedRef, title, values, overlay);
  } else if (title !== null || fresh.length > 0) {
    action = 'create';
    const name = title ?? fresh[0]!.display;
    contact = { ref: overlay.newRef(), version: null, title: name, data: values, after: { title: name, data: values } };
  } else {
    return { ...base, action: 'skip', reason: 'empty_row' };
  }

  const organization = row.organization === null ? null
    : await organizationOf(tx, deps, row.organization, row.columns, overlay, warnings);
  let membership: RowPlan['membership'] = null;
  if (organization !== null) {
    const exists = organization.action === 'found'
      && (overlay.pairs.has(pairKey(contact.ref, organization.ref))
        || (!isVirtual(contact.ref) && await activeMembershipExists(tx, deps, contact.ref, organization.ref)));
    membership = exists ? { action: 'exists' } : {
      action: 'create',
      role: rolesOf(deps.cfg, row.membership?.role ?? [], row.columns, warnings),
      position: trimmed(row.membership?.position),
    };
  }
  return { ...base, action, contact, addresses: fresh, organization, membership };
}

/**
 * The roles of a row: cells split by "," and ";", trimmed, without empties and repeats. A role outside the
 * options of `role` is a warning and the roles are skipped, as for any enum field.
 */
function rolesOf(cfg: CompiledConfig, cells: string[], columns: Record<string, string> | undefined, warnings: string[]): string[] {
  const roles = [...new Set(cells.flatMap((r) => r.split(/[,;]/)).map((r) => r.trim()).filter((r) => r !== ''))];
  const field = cfg.fields.get('role');
  const message = field === undefined || roles.length === 0 ? null : notAnOption(field, roles);
  if (message === null) return roles;
  const column = columns?.['membership.role'];
  warnings.push(`${column !== undefined ? `Колонка «${column}»` : `Поле «${field!.label}»`}: ${message}; значение пропущено`);
  return [];
}

/** The row's addresses, normalised and without repeats; unknown channels and unreadable addresses are warnings. */
function parseAddresses(cfg: CompiledConfig, row: ImportRow, warnings: string[]): PlannedAddress[] {
  const out: PlannedAddress[] = [];
  const seen = new Set<string>();
  for (const i of row.identities) {
    const channel = identityChannel(i.channel);
    if (channel === null) {
      warnings.push(`Адрес «${i.address.trim()}» пропущен: неизвестный канал «${i.channel}»`);
      continue;
    }
    for (const part of i.address.split(/[,;]/)) {
      const raw = part.trim();
      if (raw === '') continue;
      const n = normalizeAddress(channel, raw, cfg.phoneRegion);
      if (!n.ok) {
        warnings.push(`Адрес «${raw}» пропущен: ${lowerFirst(n.message)}`);
        continue;
      }
      const key = addressKey(channel, n.normalized);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ channel, normalized: n.normalized, display: n.display });
    }
  }
  return out;
}

async function holderOf(tx: Db, workspaceId: string, a: PlannedAddress, overlay: Overlay): Promise<Holder> {
  const virtual = overlay.addresses.get(addressKey(a.channel, a.normalized));
  if (virtual !== undefined) return { kind: 'contact', ref: virtual };
  const found = await liveByAddress(tx, workspaceId, a.channel, a.normalized);
  if (found === undefined) return { kind: 'none' };
  const owner = (await loadRecords(tx, [found.ownerId], { workspaceId })).get(found.ownerId);
  const skip = (why: string): Holder => ({ kind: 'skip', warning: `Адрес «${a.display}» пропущен: ${why}` });
  if (owner === undefined || owner.archivedAt !== null) return skip(`принадлежит записи в архиве «${found.ownerTitle}»`);
  if (owner.sets.has('membership')) {
    const contactId = (await linksFrom(tx, owner.id, 'contact'))[0];
    const person = contactId === undefined ? undefined : (await loadRecords(tx, [contactId], { workspaceId })).get(contactId);
    if (person === undefined || person.archivedAt !== null) return skip(`принадлежит участию «${owner.title}» без контакта`);
    return { kind: 'contact', ref: person.id };
  }
  if (owner.sets.has('contact')) return { kind: 'contact', ref: owner.id };
  if (owner.sets.has('organization')) return skip(`принадлежит организации «${owner.title}», а не человеку`);
  return skip(`принадлежит записи «${owner.title}»`);
}

/**
 * Why a coerced enum value is not one of the field's options (any part of a multiple one), or null. Rules
 * may narrow the options further; that is left to the save.
 */
function notAnOption(f: CompiledField, value: Value): string | null {
  if (f.type !== 'enum' || f.options === undefined || value === null) return null;
  const values = Array.isArray(value) ? value : [value];
  const bad = values.find((v) => typeof v !== 'string' || !f.options!.includes(v));
  return bad === undefined ? null : `«${String(bad)}» — нет среди вариантов (${f.options.join(', ')})`;
}

/** The cells of `data` coerced to their fields; a cell that does not fit (or no importable field) is a warning. */
function coerceAll(
  cfg: CompiledConfig, set: 'contact' | 'organization', data: Record<string, string>,
  columns: Record<string, string> | undefined, warnings: string[],
): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const [key, raw] of Object.entries(data)) {
    const column = columns?.[`${set}.${key}`];
    const f = importableField(cfg, set, key);
    const where = column !== undefined ? `Колонка «${column}»` : `Поле «${f?.label ?? key}»`;
    if (f === null) {
      warnings.push(`${where}: это поле нельзя заполнить импортом, значение пропущено`);
      continue;
    }
    const c = coerceCell(f, raw);
    const message = c.ok ? notAnOption(f, c.value) : c.message;
    if (message !== null) {
      warnings.push(`${where}: ${message}; значение пропущено`);
      continue;
    }
    if (c.ok && c.value !== null) out[key] = c.value;
  }
  return out;
}

/** The update of the matched contact: the row's values for its empty fields, its name when it has none. */
async function updateOf(
  tx: Db, workspaceId: string, ref: string, title: string | null, values: Record<string, Value>, overlay: Overlay,
): Promise<NonNullable<RowPlan['contact']>> {
  let version: number | null = null;
  let current = overlay.contacts.get(ref);
  if (current === undefined) {
    const stored = (await loadRecords(tx, [ref], { workspaceId })).get(ref);
    if (stored === undefined) throw new Error(`contact ${ref} vanished while planning`);
    current = { title: stored.title, data: stored.data };
    version = stored.version;
  } else if (!isVirtual(ref)) {
    version = (await loadRecords(tx, [ref], { workspaceId })).get(ref)?.version ?? null;
  }
  const fill = Object.fromEntries(Object.entries(values).filter(([k]) => isEmpty(current.data[k] ?? null)));
  const newTitle = title !== null && current.title.trim() === '' ? title : null;
  return {
    ref, version, title: newTitle, data: fill,
    after: { title: newTitle ?? current.title, data: { ...current.data, ...fill } },
  };
}

async function organizationOf(
  tx: Db, deps: PlanDeps, o: NonNullable<ImportRow['organization']>, columns: Record<string, string> | undefined,
  overlay: Overlay, warnings: string[],
): Promise<RowPlan['organization']> {
  const rawNip = trimmed(o.nip);
  const nip = rawNip === null ? null : normalizeNip(rawNip);
  if (rawNip !== null && nip === null) warnings.push(`NIP «${rawNip}» неверный и не используется`);
  const byNip = nip === null ? undefined : overlay.nips.get(nip) ?? await organizationByNip(tx, deps.workspaceId, nip);
  if (byNip !== undefined) return { action: 'found', ref: byNip };

  const title = trimmed(o.title);
  const nameNorm = title === null ? '' : normalizeCompanyName(title);
  // By name: only an organization without a NIP or with the row's one; another NIP is another firm.
  const named = nameNorm === '' ? []
    : [...await organizationsByName(tx, deps.workspaceId, nameNorm), ...(overlay.names.get(nameNorm) ?? [])];
  const byName = nip === null ? named : named.filter((n) => n.nip === null || n.nip === nip);
  const pick = byName[0];
  if (pick !== undefined) {
    if (byName.length > 1) warnings.push(`Название «${title}» есть у нескольких организаций, выбрана «${pick.title}»`);
    if (nip !== null && pick.nip === null) {
      warnings.push(`NIP «${nip}» не записан: организация «${pick.title}» найдена по названию, импорт не меняет организации`);
    }
    return { action: 'found', ref: pick.id };
  }

  if (title === null) {
    warnings.push('Нет названия организации и NIP не найден — организация пропущена');
    return null;
  }
  const data = coerceAll(deps.cfg, 'organization', o.data, columns, warnings);
  if (nip !== null) data.nip = nip;
  return { action: 'create', ref: overlay.newRef(), title, data, nip, nameNorm };
}

async function activeMembershipExists(tx: Db, deps: PlanDeps, contactId: string, organizationRef: string): Promise<boolean> {
  if (isVirtual(organizationRef)) return false;
  const ofContact = await membershipsOf(tx, deps.cfg, deps.workspaceId, { contactId }, deps.today);
  return ofContact.some((m) => m.active && m.organizationId === organizationRef);
}

import { ownedFieldsOf, todayIn, type CompiledConfig, type FieldDef, type RecordError, type Value } from '@icrm/core';
import { linksFrom } from '../repo/links.js';
import { liveRowIds, loadRecords, setOwner, type StoredRecord } from '../repo/records.js';
import type { Db } from '../repo/types.js';
import { notFound, recordError, SaveFailed } from '../service/errors.js';
import { fieldInEnabledSet, sameValue } from '../service/fields.js';
import type { SaveResult, TxOps } from '../service/record-service.js';
import { naming, relink, type HandoverDeps } from './handover.js';
import { membershipsOf, type MembershipView } from './memberships.js';

/** What is merged: a contact into a contact or an organization into an organization (spec 2a §6). */
export type MergeKind = 'contact' | 'organization';

/**
 * A step of a later sub-project that a merge runs inside its transaction, after everything of 2a moved and
 * before `A` is archived (spec 2a §6.2 p.8). A thrown error rolls the whole merge back.
 */
export type MergeStep = (tx: Db, kind: MergeKind, sourceId: string, targetId: string) => Promise<void>;

/** A field where both records hold different non-empty values (targets, for a link of one). */
export interface MergeConflict {
  field: string;
  source: Value | string[];
  target: Value | string[];
}

/** What a merge of `A` into `B` would do (spec 2a §6.1). */
export interface MergePreview {
  kind: MergeKind;
  conflicts: MergeConflict[];
  /** Live addresses of `A`. */
  identities: number;
  /** Live memberships of `A`; `collapsesInto` — the active membership of `B` with the same partner. */
  memberships: { id: string; title: string; collapsesInto: string | null }[];
  /** Links to `A` from other live records, other than those of its memberships to it. */
  links: number;
  /** Live rows of `A`. */
  rows: number;
}

/** Per conflicting field (or `title`): whose value `B` keeps; `target` when left out. */
export type MergeChoice = Record<string, 'source' | 'target'>;

export interface MergeInput {
  sourceId: string;
  targetId: string;
  values?: MergeChoice;
  userId: string;
}

export interface MergeDeps extends HandoverDeps {
  mergeSteps: readonly MergeStep[];
}

const MERGED_INTO = 'merged_into';
const MANUAL = 'manual';
const COMPUTED = new Set(['formula', 'rollup']);

const isEmpty = (v: Value | undefined): boolean =>
  v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

/** The membership field that points at a record of `kind`, and the one that points at its partner. */
const sideOf = (kind: MergeKind): { self: MergeKind; partner: (m: MembershipView) => string | null } =>
  kind === 'contact'
    ? { self: 'contact', partner: (m) => m.organizationId }
    : { self: 'organization', partner: (m) => m.contactId };

/**
 * The kind of merging `a` into `b`, or why they cannot be merged: `merge_self`, `not_found`,
 * `merge_archived`, `merge_kind_mismatch`, checked in that order.
 */
function pairCheck(
  sourceId: string, targetId: string, a: StoredRecord | undefined, b: StoredRecord | undefined,
): { kind: MergeKind; a: StoredRecord; b: StoredRecord } | { errors: RecordError[] } {
  if (sourceId === targetId) return { errors: [recordError('merge_self', 'Запись нельзя слить саму с собой')] };
  const missing = [a === undefined ? sourceId : null, b === undefined ? targetId : null].filter((x) => x !== null);
  if (missing.length > 0) return { errors: missing.map(notFound) };
  if (a!.archivedAt !== null || b!.archivedAt !== null) {
    const which = a!.archivedAt !== null ? a! : b!;
    return { errors: [recordError('merge_archived', `Запись «${which.title}» в архиве, её нельзя сливать`)] };
  }
  for (const kind of ['contact', 'organization'] as const) {
    if (a!.sets.has(kind) && b!.sets.has(kind)) return { kind, a: a!, b: b! };
  }
  return { errors: [recordError('merge_kind_mismatch', 'Сливать можно только контакт с контактом или организацию с организацией')] };
}

/** The fields of `sets` that are plain values a person enters: not computed, not links, not `managed`, not `title`. */
function valueFields(cfg: CompiledConfig, sets: Iterable<string>): string[] {
  return fieldsOf(cfg, sets, (f) => f.type !== 'link' && !COMPUTED.has(f.type) && f.managed !== true && f.key !== 'title');
}

/** The link fields of `sets` a merge carries over: not `managed`, not owned (rows move by owner). */
function linkFields(cfg: CompiledConfig, sets: Iterable<string>): FieldDef[] {
  return fieldsOf(cfg, sets, (f) => f.type === 'link' && f.managed !== true && f.owned !== true).map((k) => cfg.fields.get(k)!);
}

function fieldsOf(cfg: CompiledConfig, sets: Iterable<string>, keep: (f: FieldDef) => boolean): string[] {
  const out = new Set<string>();
  for (const s of sets) {
    for (const key of cfg.sets.get(s)?.fields ?? []) {
      const f = cfg.fields.get(key);
      if (f !== undefined && keep(f)) out.add(key);
    }
  }
  return [...out];
}

/** Live targets of `fromId` through `field`, without `a` and `b` themselves (a merged record does not link to itself). */
async function carriedTargets(tx: Db, workspaceId: string, fromId: string, field: string, a: string, b: string): Promise<string[]> {
  const ids = (await linksFrom(tx, fromId, field)).filter((t) => t !== a && t !== b);
  const loaded = await loadRecords(tx, ids, { workspaceId });
  return ids.filter((t) => loaded.get(t)?.archivedAt === null);
}

/** The conflicts of merging `a` into `b` (spec 2a §6.1), in field order of `a`'s sets, `title` first. */
async function conflictsOf(tx: Db, cfg: CompiledConfig, workspaceId: string, a: StoredRecord, b: StoredRecord): Promise<MergeConflict[]> {
  const out: MergeConflict[] = [];
  if (!isEmpty(a.title) && !isEmpty(b.title) && a.title !== b.title) out.push({ field: 'title', source: a.title, target: b.title });
  for (const key of valueFields(cfg, a.sets.keys())) {
    const [sv, tv] = [a.data[key], b.data[key]];
    if (!isEmpty(sv) && !isEmpty(tv) && !sameValue(sv, tv)) out.push({ field: key, source: sv!, target: tv! });
  }
  for (const f of linkFields(cfg, a.sets.keys())) {
    if (f.cardinality !== 'one') continue;
    const source = await carriedTargets(tx, workspaceId, a.id, f.key, a.id, b.id);
    const target = await carriedTargets(tx, workspaceId, b.id, f.key, a.id, b.id);
    if (source.length > 0 && target.length > 0 && !sameValue(source, target)) out.push({ field: f.key, source, target });
  }
  return out;
}

/** The links to `toId` from other live records of the workspace, other than `merged_into`, oldest first. */
async function incomingOf(tx: Db, workspaceId: string, toId: string): Promise<{ fromId: string; field: string }[]> {
  const rows = await tx.selectFrom('links')
    .innerJoin('records', 'records.id', 'links.from_id')
    .select(['links.from_id', 'links.field_key'])
    .where('links.to_id', '=', toId).where('links.workspace_id', '=', workspaceId)
    .where('links.field_key', '<>', MERGED_INTO).where('links.from_id', '<>', toId)
    .where('records.archived_at', 'is', null)
    .orderBy('links.created_at').orderBy('links.id').execute();
  return rows.map((r) => ({ fromId: r.from_id, field: r.field_key }));
}

/** The live memberships of `a` and, per active one, the active membership of `b` with the same partner. */
async function membershipPlan(
  tx: Db, d: MergeDeps, kind: MergeKind, aId: string, bId: string, today: string,
): Promise<{ ofA: MembershipView[]; twins: Map<string, MembershipView> }> {
  const by = (id: string): { contactId: string } | { organizationId: string } =>
    kind === 'contact' ? { contactId: id } : { organizationId: id };
  const ofA = await membershipsOf(tx, d.cfg, d.workspaceId, by(aId), today);
  const ofB = await membershipsOf(tx, d.cfg, d.workspaceId, by(bId), today);
  const { partner } = sideOf(kind);
  const twins = new Map<string, MembershipView>();
  for (const m of ofA) {
    const twin = m.active ? ofB.find((x) => x.active && partner(x) !== null && partner(x) === partner(m)) : undefined;
    if (twin !== undefined) twins.set(m.id, twin);
  }
  return { ofA, twins };
}

/** What a merge of `sourceId` into `targetId` would do (spec 2a §6.1); nothing is locked or changed. */
export async function mergePreview(
  d: MergeDeps, sourceId: string, targetId: string,
): Promise<{ ok: true; preview: MergePreview } | { ok: false; errors: RecordError[] }> {
  const loaded = await loadRecords(d.db, [sourceId, targetId], { workspaceId: d.workspaceId });
  const pair = pairCheck(sourceId, targetId, loaded.get(sourceId), loaded.get(targetId));
  if ('errors' in pair) return { ok: false, errors: pair.errors };
  const { kind, a, b } = pair;
  const today = todayIn(d.now(), d.cfg.timezone);
  const { ofA, twins } = await membershipPlan(d.db, d, kind, a.id, b.id, today);
  const own = new Set(ofA.map((m) => m.id));
  const links = (await incomingOf(d.db, d.workspaceId, a.id)).filter((l) => !(own.has(l.fromId) && l.field === kind));
  return {
    ok: true,
    preview: {
      kind,
      conflicts: await conflictsOf(d.db, d.cfg, d.workspaceId, a, b),
      identities: (await d.identities.liveOf(d.db, [a.id])).length,
      memberships: ofA.map((m) => ({ id: m.id, title: m.title, collapsesInto: twins.get(m.id)?.id ?? null })),
      links: links.length,
      rows: (await liveRowIds(d.db, [a.id], d.workspaceId)).length,
    },
  };
}

const versionOf = async (tx: Db, workspaceId: string, id: string): Promise<number> =>
  (await loadRecords(tx, [id], { workspaceId, forUpdate: true })).get(id)?.version ?? -1;

/**
 * Merges `sourceId` (`A`) into `targetId` (`B`) in one transaction (spec 2a §6.2): `A` and `B` are locked
 * first (id order) and checked; `B` gets the manual sets of `A` it lacks; then addresses, memberships (twins
 * collapse into the one of `B`), links to `A`, rows and own links of `A`, users move to `B`; the merge steps
 * run; `A` gets `merged_into = B` and is archived; last, `B` gets the chosen and its empty values (after the
 * archive of `A`, so a shared NIP does not stand in the way). Any failure rolls everything back. The result is the view
 * of `B` after commit.
 */
export async function merge(d: MergeDeps, i: MergeInput): Promise<SaveResult> {
  const choice = i.values ?? {};
  const res = await d.records.transaction(i.userId, async (ops) => {
    const tx = ops.tx;
    const locked = i.sourceId === i.targetId
      ? new Map<string, StoredRecord>()
      : await loadRecords(tx, [i.sourceId, i.targetId], { workspaceId: d.workspaceId, forUpdate: true });
    const pair = pairCheck(i.sourceId, i.targetId, locked.get(i.sourceId), locked.get(i.targetId));
    if ('errors' in pair) throw new SaveFailed(pair.errors);
    const { kind, a, b } = pair;
    const unknown = Object.keys(choice).filter((k) => !d.cfg.fields.has(k));
    if (unknown.length > 0) {
      throw new SaveFailed(unknown.map((k) => recordError('unknown_field', `Поле "${k}" не найдено`, { field: k })));
    }
    const today = todayIn(d.now(), d.cfg.timezone);

    // 0. The manual sets of A that B lacks, first: links to A and own links of A may need them on B. They come
    // with A's values of the fields only those sets have (not in any set of B, so never the NIP or another
    // field of B's kind), so that their rules (`require` of such a field) pass; the rest of the values waits
    // for step 9. A `require` of a link field of such a set still fails here, before the links move.
    const enableSets = [...a.sets].filter(([key, by]) => by === MANUAL && !b.sets.has(key)).map(([key]) => key);
    const early = new Set<string>();
    if (enableSets.length > 0) {
      const gained = new Set(enableSets.flatMap((k) => d.cfg.sets.get(k)?.closure ?? [k]).filter((k) => !b.sets.has(k)));
      const data: Record<string, Value> = {};
      for (const key of valueFields(d.cfg, gained)) {
        if (fieldInEnabledSet(d.cfg, b.sets, key) || isEmpty(a.data[key])) continue;
        data[key] = a.data[key]!;
        early.add(key);
      }
      await ops.update({ id: b.id, userId: i.userId, expectedVersion: b.version, enableSets, data });
    }

    // 1. Addresses.
    for (const x of await d.identities.liveOf(tx, [a.id])) await d.identities.moveIn(tx, x.id, b.id, i.userId);

    // 2. Memberships: twins collapse into the one of B before anything is re-pointed.
    await collapseMemberships(d, ops, kind, a.id, b.id, today, i.userId);

    // 3. Links to A from other live records (memberships included); B's own link to A is dropped.
    for (const l of await incomingOf(tx, d.workspaceId, a.id)) {
      await relink(ops, d.workspaceId, l, a.id, l.fromId === b.id ? null : b.id, i.userId);
    }

    // 4–5. Rows and own links of A go to the same fields of B; a field B still lacks (of a set that only a
    // rule enables) is written after the values of B, which may enable it.
    const later: { field: string; targets: () => Promise<string[] | null> }[] = [];
    const writeB = async (field: string, targets: () => Promise<string[] | null>): Promise<void> => {
      const fresh = (await loadRecords(tx, [b.id], { workspaceId: d.workspaceId })).get(b.id)!;
      if (!fieldInEnabledSet(d.cfg, fresh.sets, field)) {
        later.push({ field, targets });
        return;
      }
      const next = await targets();
      if (next !== null) await naming(b.id, field, () => ops.setLinks({ id: b.id, userId: i.userId, field, targetIds: next }));
    };
    const rows = new Set(await liveRowIds(tx, [a.id], d.workspaceId));
    await setOwner(tx, [...rows], b.id);
    for (const field of ownedFieldsOf(d.cfg, a.sets.keys())) {
      const moved = (await linksFrom(tx, a.id, field)).filter((id) => rows.has(id));
      if (moved.length === 0) continue;
      await writeB(field, async () => [...await linksFrom(tx, b.id, field), ...moved]);
    }
    for (const f of linkFields(d.cfg, a.sets.keys())) {
      const carried = await carriedTargets(tx, d.workspaceId, a.id, f.key, a.id, b.id);
      if (carried.length === 0) continue;
      await writeB(f.key, async () => {
        const current = await linksFrom(tx, b.id, f.key);
        const next = f.cardinality === 'one'
          ? (current.length === 0 || choice[f.key] === 'source' ? carried : current)
          : [...current, ...carried.filter((t) => !current.includes(t))];
        return sameValue(next, current) ? null : next;
      });
    }

    // 6. Users.
    await tx.updateTable('users').set({ contact_record_id: b.id })
      .where('workspace_id', '=', d.workspaceId).where('contact_record_id', '=', a.id).execute();

    // 7. Steps of later sub-projects.
    for (const step of d.mergeSteps) await step(tx, kind, a.id, b.id);

    // 8. A is archived with merged_into = B.
    await ops.setLinks({ id: a.id, userId: i.userId, field: MERGED_INTO, targetIds: [b.id], system: true });
    await ops.archive({ id: a.id, userId: i.userId });

    // 9. Values of B (after the archive of A, so a shared NIP does not stand in the way).
    const bNow = (await loadRecords(tx, [b.id], { workspaceId: d.workspaceId, forUpdate: true })).get(b.id)!;
    const data: Record<string, Value> = {};
    for (const key of valueFields(d.cfg, a.sets.keys())) {
      if (early.has(key)) continue;
      const [sv, tv] = [a.data[key], bNow.data[key]];
      if (isEmpty(sv) || sameValue(sv, tv)) continue;
      if (isEmpty(tv) || choice[key] === 'source') data[key] = sv!;
    }
    const takeTitle = !isEmpty(a.title) && a.title !== bNow.title && (isEmpty(bNow.title) || choice.title === 'source');
    if (Object.keys(data).length > 0 || takeTitle) {
      await ops.update({
        id: b.id, userId: i.userId, expectedVersion: bNow.version, data,
        ...(takeTitle ? { title: a.title } : {}),
      });
    }
    for (const w of later) {
      const next = await w.targets();
      if (next !== null) await naming(b.id, w.field, () => ops.setLinks({ id: b.id, userId: i.userId, field: w.field, targetIds: next }));
    }
  });
  if (!res.ok) return res;
  const record = await d.records.get(i.targetId);
  return record === null ? { ok: false, errors: [notFound(i.targetId)] } : { ok: true, record };
}

/**
 * Spec 2a §6.2 p.3. An active membership of `A` whose partner also has an active membership of `B` collapses
 * into the latter: its addresses and the links to it move there, roles are joined (and its primary flag, when
 * that conflicts with nothing), and it is closed today and archived. Then, for a contact, an active primary
 * membership of `A` loses the flag when `B` already has one, so that re-pointing it to `B` does not conflict.
 */
async function collapseMemberships(
  d: MergeDeps, ops: TxOps, kind: MergeKind, aId: string, bId: string, today: string, userId: string,
): Promise<void> {
  const tx = ops.tx;
  const { ofA, twins } = await membershipPlan(tx, d, kind, aId, bId, today);
  for (const m of ofA) {
    const twin = twins.get(m.id);
    if (twin === undefined) continue;
    for (const x of await d.identities.liveOf(tx, [m.id])) await d.identities.moveIn(tx, x.id, twin.id, userId);
    for (const l of await incomingOf(tx, d.workspaceId, m.id)) await relink(ops, d.workspaceId, l, m.id, twin.id, userId);
    await ops.update({ id: m.id, userId, expectedVersion: await versionOf(tx, d.workspaceId, m.id), data: { active_to: today } });
    await ops.archive({ id: m.id, userId });

    const data: Record<string, Value> = {};
    const roles = [...twin.role, ...m.role.filter((r) => !twin.role.includes(r))];
    if (roles.length > twin.role.length) data.role = roles;
    if (m.isPrimary && !twin.isPrimary && twin.contactId !== null) {
      const others = await membershipsOf(tx, d.cfg, d.workspaceId, { contactId: twin.contactId }, today);
      if (!others.some((o) => o.id !== twin.id && o.active && o.isPrimary)) data.is_primary = true;
    }
    if (Object.keys(data).length > 0) {
      await ops.update({ id: twin.id, userId, expectedVersion: await versionOf(tx, d.workspaceId, twin.id), data });
    }
  }
  if (kind !== 'contact') return;
  const ofB = await membershipsOf(tx, d.cfg, d.workspaceId, { contactId: bId }, today);
  if (!ofB.some((m) => m.active && m.isPrimary)) return;
  for (const m of ofA) {
    if (twins.has(m.id) || !m.active || !m.isPrimary) continue;
    await ops.update({ id: m.id, userId, expectedVersion: await versionOf(tx, d.workspaceId, m.id), data: { is_primary: false } });
  }
}

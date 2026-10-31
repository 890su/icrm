import { todayIn, type CompiledConfig, type RecordError, type Value } from '@icrm/core';
import type { Kysely } from 'kysely';
import { loadIdentity } from '../repo/identities.js';
import { linksFrom } from '../repo/links.js';
import { loadRecords, type StoredRecord } from '../repo/records.js';
import type { Db } from '../repo/types.js';
import type { DB } from '../schema.js';
import { archived, recordError, SaveFailed, versionConflict } from '../service/errors.js';
import type { RecordService, RecordView, TxOps } from '../service/record-service.js';
import type { IdentityService, IdentityView } from './identities.js';
import { isActiveOn } from './memberships.js';

/** A link into a membership (or an organization) from another record, as the handover preview shows it. */
export interface HandoverLink {
  linkId: string;
  field: string;
  fromId: string;
  fromTitle: string;
  /** The field's `target_sets` include `organization`: the link may be handed to the organization. */
  organizationAllowed: boolean;
}

/** What hangs on a membership (spec 2a §5.1) or lies unassigned at an organization (§5.3). */
export interface Handover {
  identities: IdentityView[];
  links: HandoverLink[];
}

export type IdentityTarget = 'successor' | 'organization' | 'contact' | 'keep' | 'archive';
export type LinkTarget = 'successor' | 'organization' | 'keep';

export interface EndMembershipInput {
  id: string;
  version: number;
  /** The last day of the membership ("YYYY-MM-DD"), stored as its `active_to`. */
  date: string;
  userId: string;
  /** An existing membership of the same organization, or a contact to create one for, or nobody. */
  successor: { membershipId: string } | { contactId: string; role?: string[]; position?: string | null } | null;
  /** Targets per identity id of the preview; the ones left out get the default of spec 2a §5.2 p.5. */
  identities?: Record<string, IdentityTarget>;
  /** Targets per link id of the preview; the ones left out get the default of spec 2a §5.2 p.5. */
  links?: Record<string, LinkTarget>;
}

export type HandoverResult =
  | { ok: true; membership: RecordView; successor: RecordView | null }
  | { ok: false; errors: RecordError[] };

export interface HandoverDeps {
  db: Kysely<DB>;
  cfg: CompiledConfig;
  workspaceId: string;
  now: () => Date;
  records: RecordService;
  identities: IdentityService;
}

const invalid = (message: string): RecordError => recordError('handover_target_invalid', message);
const membershipNotFound = (id: string): RecordError => recordError('not_found', `Участие ${id} не найдено`);
const filled = (v: Value | undefined): boolean => v !== undefined && v !== null && v !== '';

/** The link fields that may point at a membership, i.e. whose `target_sets` include `membership`. */
function membershipCapableFields(cfg: CompiledConfig): Map<string, { label: string; organizationAllowed: boolean }> {
  const out = new Map<string, { label: string; organizationAllowed: boolean }>();
  for (const [key, f] of cfg.fields) {
    if (f.type !== 'link' || !(f.target_sets ?? []).includes('membership')) continue;
    out.set(key, { label: f.label, organizationAllowed: (f.target_sets ?? []).includes('organization') });
  }
  return out;
}

/**
 * The links to `toId` from live records of the workspace through fields that may point at a membership,
 * oldest first: the links of a membership's preview, or the links of an organization that a membership
 * could take.
 */
async function incomingLinks(tx: Db, cfg: CompiledConfig, workspaceId: string, toId: string): Promise<HandoverLink[]> {
  const fields = membershipCapableFields(cfg);
  if (fields.size === 0) return [];
  const rows = await tx.selectFrom('links')
    .innerJoin('records', 'records.id', 'links.from_id')
    .select(['links.id', 'links.field_key', 'links.from_id', 'records.title'])
    .where('links.to_id', '=', toId).where('links.workspace_id', '=', workspaceId)
    .where('links.field_key', 'in', [...fields.keys()]).where('records.archived_at', 'is', null)
    .orderBy('links.created_at').orderBy('links.id').execute();
  return rows.map((r) => ({
    linkId: r.id, field: r.field_key, fromId: r.from_id, fromTitle: r.title,
    organizationAllowed: fields.get(r.field_key)!.organizationAllowed,
  }));
}

const linkName = (cfg: CompiledConfig, l: HandoverLink): string =>
  `Связь «${cfg.fields.get(l.field)?.label ?? l.field}» записи «${l.fromTitle}»`;

/** A record of the workspace with `set`, or null. */
async function recordWith(tx: Db, workspaceId: string, id: string, set: string, forUpdate = false): Promise<StoredRecord | null> {
  const r = (await loadRecords(tx, [id], { workspaceId, forUpdate })).get(id);
  return r !== undefined && r.sets.has(set) ? r : null;
}

/** Locks a live membership of the workspace (`not_found` / `archived` otherwise). */
async function lockMembership(tx: Db, workspaceId: string, id: string): Promise<StoredRecord> {
  const m = await recordWith(tx, workspaceId, id, 'membership', true);
  if (m === null) throw new SaveFailed([membershipNotFound(id)]);
  if (m.archivedAt !== null) throw new SaveFailed([archived(id)]);
  return m;
}

/** The preview of membership `membershipId` (spec 2a §5.1); null when there is no such membership. */
export async function handoverOf(d: HandoverDeps, membershipId: string): Promise<Handover | null> {
  if (await recordWith(d.db, d.workspaceId, membershipId, 'membership') === null) return null;
  return {
    identities: await d.identities.liveOf(d.db, [membershipId]),
    links: await incomingLinks(d.db, d.cfg, d.workspaceId, membershipId),
  };
}

/** What an organization holds that a membership could take (spec 2a §5.3); null when there is no such organization. */
export async function unassignedOf(d: HandoverDeps, organizationId: string): Promise<Handover | null> {
  if (await recordWith(d.db, d.workspaceId, organizationId, 'organization') === null) return null;
  return {
    identities: await d.identities.liveOf(d.db, [organizationId]),
    links: await incomingLinks(d.db, d.cfg, d.workspaceId, organizationId),
  };
}

/**
 * Re-points the link of record `l.fromId` through `l.field` from `from` to `to` (null: drops it) by saving
 * that source record through the regular pipeline (rules, readonly, cardinality, behaviours, log; the cascade
 * runs with the transaction's); a target already there is not repeated. The source is locked (after its
 * owner, when it is a row) before its targets are read; a link that vanished meanwhile is a
 * `version_conflict` of the source. Errors of that save name the source record (and the field, when they
 * have none).
 */
export async function relink(
  ops: TxOps, workspaceId: string, l: { fromId: string; field: string }, from: string, to: string | null, userId: string,
): Promise<void> {
  const ownerId = (await loadRecords(ops.tx, [l.fromId], { workspaceId })).get(l.fromId)?.ownerId ?? null;
  if (ownerId !== null) await loadRecords(ops.tx, [ownerId], { workspaceId, forUpdate: true });
  await loadRecords(ops.tx, [l.fromId], { workspaceId, forUpdate: true });
  const targets = await linksFrom(ops.tx, l.fromId, l.field);
  if (!targets.includes(from)) throw new SaveFailed([{ ...versionConflict(l.fromId), recordId: l.fromId, field: l.field }]);
  const next = [...new Set(targets.flatMap((t) => (t !== from ? [t] : to === null ? [] : [to])))];
  await naming(l.fromId, l.field, () => ops.setLinks({ id: l.fromId, userId, field: l.field, targetIds: next }));
}

/**
 * Runs `save` of record `recordId`; its errors name that record (and `field`, when given and they have none).
 */
export async function naming<T>(recordId: string, field: string | null, save: () => Promise<T>): Promise<T> {
  try {
    return await save();
  } catch (e) {
    if (!(e instanceof SaveFailed)) throw e;
    throw new SaveFailed(e.errors.map((x) => {
      const named = { ...x, recordId: x.recordId ?? recordId };
      return field === null || x.field !== undefined ? named : { ...named, field };
    }));
  }
}

/** The views of the saved records after commit (the cascade may have changed them after the transaction's work). */
async function result(d: HandoverDeps, membershipId: string, successorId: string | null): Promise<HandoverResult> {
  const membership = await d.records.get(membershipId);
  const successor = successorId === null ? null : await d.records.get(successorId);
  if (membership === null) return { ok: false, errors: [membershipNotFound(membershipId)] };
  if (successorId !== null && successor === null) return { ok: false, errors: [membershipNotFound(successorId)] };
  return { ok: true, membership, successor };
}

/**
 * Ends a membership and hands over what hangs on it (spec 2a §5.2), in one transaction: closes it
 * (`active_to = date`), finds or creates the successor, then moves its addresses and re-points the links to
 * it. Every target is checked before anything changes; any failure rolls everything back.
 */
export async function endMembership(d: HandoverDeps, i: EndMembershipInput): Promise<HandoverResult> {
  const res = await d.records.transaction(i.userId, async (ops) => {
    const tx = ops.tx;
    const m = await lockMembership(tx, d.workspaceId, i.id);
    if (m.version !== i.version) throw new SaveFailed([versionConflict(m.id)]);
    if (filled(m.data.active_to)) {
      throw new SaveFailed([recordError('membership_ended', `Участие «${m.title}» уже закрыто`, { field: 'active_to' })]);
    }
    const contactId = (await linksFrom(tx, m.id, 'contact'))[0] ?? null;
    const organizationId = (await linksFrom(tx, m.id, 'organization'))[0] ?? null;
    const identities = await d.identities.liveOf(tx, [m.id]);
    const links = await incomingLinks(tx, d.cfg, d.workspaceId, m.id);

    const errors: RecordError[] = [];
    let successorId: string | null = null;
    if (i.successor !== null && 'membershipId' in i.successor) {
      const s = await recordWith(tx, d.workspaceId, i.successor.membershipId, 'membership', true);
      const sameOrg = s !== null && organizationId !== null
        && (await linksFrom(tx, s.id, 'organization'))[0] === organizationId;
      if (s === null || s.id === m.id || s.archivedAt !== null || !sameOrg || !isActiveOn(s.data.active_to, i.date)) {
        errors.push(invalid('Преемник должен быть другим участием той же организации, действующим на дату ухода'));
      } else {
        successorId = s.id;
      }
    }
    const hasSuccessor = i.successor !== null;

    const identityTargets = new Map<IdentityView, IdentityTarget>();
    for (const key of Object.keys(i.identities ?? {})) {
      if (!identities.some((x) => x.id === key)) errors.push(invalid(`Адрес ${key} не принадлежит участию «${m.title}»`));
    }
    for (const x of identities) {
      const target = i.identities?.[x.id] ?? (hasSuccessor ? 'successor' : 'organization');
      if (target === 'successor' && !hasSuccessor) errors.push(invalid(`Адрес ${x.display}: преемник не указан`));
      if (target === 'contact' && contactId === null) errors.push(invalid(`Адрес ${x.display}: у участия нет контакта`));
      if (target === 'organization' && organizationId === null) errors.push(invalid(`Адрес ${x.display}: у участия нет организации`));
      identityTargets.set(x, target);
    }

    const linkTargets = new Map<HandoverLink, LinkTarget>();
    for (const key of Object.keys(i.links ?? {})) {
      if (!links.some((l) => l.linkId === key)) errors.push(invalid(`Связь ${key} не ведёт на участие «${m.title}»`));
    }
    for (const l of links) {
      const target = i.links?.[l.linkId] ?? (hasSuccessor ? 'successor' : l.organizationAllowed ? 'organization' : 'keep');
      if (target === 'successor' && !hasSuccessor) errors.push(invalid(`${linkName(d.cfg, l)}: преемник не указан`));
      if (target === 'organization' && (!l.organizationAllowed || organizationId === null)) {
        errors.push(invalid(`${linkName(d.cfg, l)} не допускает организацию`));
      }
      linkTargets.set(l, target);
    }
    if (errors.length > 0) throw new SaveFailed(errors);

    await ops.update({ id: m.id, userId: i.userId, expectedVersion: i.version, data: { active_to: i.date } });
    if (i.successor !== null && 'contactId' in i.successor) {
      const data: Record<string, Value> = {};
      const role = i.successor.role ?? m.data.role;
      if (role !== undefined) data.role = role;
      const position = i.successor.position !== undefined ? i.successor.position : m.data.position;
      if (position !== undefined) data.position = position;
      const created = await ops.create({
        userId: i.userId, title: '', sets: ['membership'], data,
        links: { contact: [i.successor.contactId], organization: organizationId === null ? [] : [organizationId] },
      });
      successorId = created.id;
    }

    const ownerOf = { successor: successorId, organization: organizationId, contact: contactId };
    for (const [x, target] of identityTargets) {
      if (target === 'keep') continue;
      if (target === 'archive') await d.identities.archiveIn(tx, x.id, i.userId);
      else await d.identities.moveIn(tx, x.id, ownerOf[target]!, i.userId);
    }
    for (const [l, target] of linkTargets) {
      if (target !== 'keep') await relink(ops, d.workspaceId, l, m.id, ownerOf[target]!, i.userId);
    }
    return { successorId };
  });
  return res.ok ? result(d, i.id, res.value.successorId) : res;
}

/**
 * Hands addresses and links of an organization to one of its active memberships (spec 2a §5.3), in one
 * transaction. Each address must belong to the organization and each link must lead to it from a field
 * that may point at a membership (`handover_target_invalid` otherwise, checked before anything changes).
 */
export async function take(
  d: HandoverDeps, i: { membershipId: string; identities: string[]; links: string[]; userId: string },
): Promise<HandoverResult> {
  const res = await d.records.transaction(i.userId, async (ops) => {
    const tx = ops.tx;
    const m = await lockMembership(tx, d.workspaceId, i.membershipId);
    const organizationId = (await linksFrom(tx, m.id, 'organization'))[0] ?? null;
    const errors: RecordError[] = [];
    if (!isActiveOn(m.data.active_to, todayIn(d.now(), d.cfg.timezone)) || organizationId === null) {
      errors.push(invalid(`Участие «${m.title}» не действует, закрепить за ним ничего нельзя`));
    }
    const identityIds = [...new Set(i.identities)];
    for (const id of identityIds) {
      const x = await loadIdentity(tx, d.workspaceId, id);
      if (x === undefined || x.archivedAt !== null || x.ownerId !== organizationId) {
        errors.push(invalid(`Адрес ${x?.display ?? id} не принадлежит организации участия «${m.title}»`));
      }
    }
    const free = organizationId === null ? [] : await incomingLinks(tx, d.cfg, d.workspaceId, organizationId);
    const links: HandoverLink[] = [];
    for (const id of new Set(i.links)) {
      const l = free.find((f) => f.linkId === id);
      if (l === undefined) errors.push(invalid(`Связь ${id} не ведёт на организацию участия «${m.title}» из поля, допускающего участие`));
      else links.push(l);
    }
    if (errors.length > 0) throw new SaveFailed(errors);

    for (const id of identityIds) await d.identities.moveIn(tx, id, m.id, i.userId);
    for (const l of links) await relink(ops, d.workspaceId, l, organizationId!, m.id, i.userId);
  });
  return res.ok ? result(d, i.membershipId, null) : res;
}

import { todayIn, type CompiledConfig, type RecordError, type Value } from '@icrm/core';
import { sql } from 'kysely';
import { linksFrom, linksTo } from '../repo/links.js';
import { loadRecords, type StoredRecord } from '../repo/records.js';
import type { Db } from '../repo/types.js';
import { recordError } from '../service/errors.js';

/** A membership (spec 2a §2.4) as shown in the view of its contact or organization. */
export interface MembershipView {
  id: string;
  title: string;
  contactId: string | null;
  contactTitle: string | null;
  organizationId: string | null;
  organizationTitle: string | null;
  role: string[];
  position: string | null;
  activeFrom: string | null;
  activeTo: string | null;
  isPrimary: boolean;
  /** `active_to` is empty or not before today (in the workspace timezone). */
  active: boolean;
}

/** A membership with this end date is active on `today` ("YYYY-MM-DD"): no end date, or one not before today. */
export function isActiveOn(activeTo: Value | undefined, today: string): boolean {
  return typeof activeTo !== 'string' || activeTo === '' || activeTo >= today;
}

const isLiveMembership = (r: StoredRecord | undefined): r is StoredRecord =>
  r !== undefined && r.archivedAt === null && r.sets.has('membership');

const text = (v: Value | undefined): string | null => (typeof v === 'string' && v !== '' ? v : null);

/**
 * Live memberships linked to `contactId` (field `contact`) or `organizationId` (field `organization`):
 * active ones first, then closed ones; each group by `activeFrom` descending (no date last), then by id.
 */
export async function membershipsOf(
  tx: Db, cfg: CompiledConfig, workspaceId: string,
  by: { contactId: string } | { organizationId: string }, today: string,
): Promise<MembershipView[]> {
  if (!cfg.sets.has('membership')) return [];
  const [field, target] = 'contactId' in by ? (['contact', by.contactId] as const) : (['organization', by.organizationId] as const);
  const loaded = await loadRecords(tx, await linksTo(tx, target, field), { workspaceId });
  const live = [...loaded.values()].filter(isLiveMembership);
  if (live.length === 0) return [];

  const linkRows = await tx.selectFrom('links').select(['from_id', 'field_key', 'to_id'])
    .where('from_id', 'in', live.map((m) => m.id)).where('field_key', 'in', ['contact', 'organization'])
    .orderBy('position').orderBy('created_at').execute();
  const targetOf = (id: string, key: string): string | null =>
    linkRows.find((l) => l.from_id === id && l.field_key === key)?.to_id ?? null;
  const titles = await loadRecords(tx, linkRows.map((l) => l.to_id), { workspaceId });

  const views = live.map((m): MembershipView => {
    const contactId = targetOf(m.id, 'contact');
    const organizationId = targetOf(m.id, 'organization');
    return {
      id: m.id,
      title: m.title,
      contactId,
      contactTitle: contactId === null ? null : titles.get(contactId)?.title ?? null,
      organizationId,
      organizationTitle: organizationId === null ? null : titles.get(organizationId)?.title ?? null,
      role: Array.isArray(m.data.role) ? m.data.role.filter((r): r is string => typeof r === 'string') : [],
      position: text(m.data.position),
      activeFrom: text(m.data.active_from),
      activeTo: text(m.data.active_to),
      isPrimary: m.data.is_primary === true,
      active: isActiveOn(m.data.active_to, today),
    };
  });
  const byFrom = (a: MembershipView, b: MembershipView): number =>
    (b.activeFrom ?? '').localeCompare(a.activeFrom ?? '') || a.id.localeCompare(b.id);
  return [...views.filter((v) => v.active).sort(byFrom), ...views.filter((v) => !v.active).sort(byFrom)];
}

/** The title of a new membership without one: "<contact> — <organization>"; null when a link is missing. */
export async function membershipTitle(tx: Db, workspaceId: string, membershipId: string): Promise<string | null> {
  const contactId = (await linksFrom(tx, membershipId, 'contact'))[0];
  const organizationId = (await linksFrom(tx, membershipId, 'organization'))[0];
  if (contactId === undefined || organizationId === undefined) return null;
  const titles = await loadRecords(tx, [contactId, organizationId], { workspaceId });
  const contact = titles.get(contactId);
  const organization = titles.get(organizationId);
  return contact === undefined || organization === undefined ? null : `${contact.title} — ${organization.title}`;
}

/**
 * The constraints of a saved membership (spec 2a §2.4), judged under a transaction lock on its contact so
 * that two concurrent saves cannot both pass: an active membership has no active twin for the same
 * organization (`membership_active_exists`) and, when primary, no other active primary one of the contact
 * (`primary_conflict`). Closed memberships are never in conflict. Does not trust the stored `is_active`.
 */
export async function membershipErrors(
  tx: Db, cfg: CompiledConfig, workspaceId: string, membership: StoredRecord, now: Date,
): Promise<RecordError[]> {
  if (membership.archivedAt !== null) return [];
  const contactId = (await linksFrom(tx, membership.id, 'contact'))[0];
  if (contactId === undefined) return [];
  await sql`select pg_advisory_xact_lock(hashtext(${workspaceId} || ':membership:' || ${contactId}))`.execute(tx);

  const today = todayIn(now, cfg.timezone);
  if (!isActiveOn(membership.data.active_to, today)) return [];
  const others = (await linksTo(tx, contactId, 'contact')).filter((id) => id !== membership.id);
  const siblings = await loadRecords(tx, others, { workspaceId });
  const active = [...siblings.values()].filter((m) => isLiveMembership(m) && isActiveOn(m.data.active_to, today));

  const errors: RecordError[] = [];
  const organizationId = (await linksFrom(tx, membership.id, 'organization'))[0];
  if (organizationId !== undefined && active.length > 0) {
    const twin = await tx.selectFrom('links').select('from_id')
      .where('field_key', '=', 'organization').where('to_id', '=', organizationId)
      .where('from_id', 'in', active.map((m) => m.id)).limit(1).executeTakeFirst();
    if (twin !== undefined) {
      errors.push(recordError('membership_active_exists',
        'У контакта уже есть действующее участие в этой организации', { field: 'organization' }));
    }
  }
  if (membership.data.is_primary === true && active.some((m) => m.data.is_primary === true)) {
    errors.push(recordError('primary_conflict', 'У контакта уже есть основное участие', { field: 'is_primary' }));
  }
  return errors;
}

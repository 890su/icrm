import type { Channel } from '@icrm/core';
import { sql, type Selectable } from 'kysely';
import type { IdentitiesTable } from '../schema.js';
import type { Db } from './types.js';

/** A channel address of a contact, membership or organization (spec 2a §3.1). */
export interface IdentityView {
  id: string;
  ownerId: string;
  channel: Channel;
  /** The normalised address: what is compared and what is unique among the live ones. */
  address: string;
  /** The address as entered. */
  display: string;
  label: string | null;
  verified: boolean;
  createdAt: string;
  archivedAt: string | null;
}

const toView = (r: Selectable<IdentitiesTable>): IdentityView => ({
  id: r.id,
  ownerId: r.owner_id,
  channel: r.channel as Channel,
  address: r.address_normalized,
  display: r.address_display,
  label: r.label,
  verified: r.verified,
  createdAt: r.created_at.toISOString(),
  archivedAt: r.archived_at?.toISOString() ?? null,
});

export async function insertIdentity(
  tx: Db,
  r: {
    id: string; workspaceId: string; ownerId: string; channel: Channel; address: string; display: string;
    label: string | null; verified: boolean;
  },
): Promise<IdentityView> {
  const row = await tx.insertInto('identities').values({
    id: r.id, workspace_id: r.workspaceId, owner_id: r.ownerId, channel: r.channel,
    address_normalized: r.address, address_display: r.display, label: r.label, verified: r.verified,
  }).returningAll().executeTakeFirstOrThrow();
  return toView(row);
}

/** The identity of the workspace, or undefined; `forUpdate` locks the row. */
export async function loadIdentity(
  tx: Db, workspaceId: string, id: string, opts: { forUpdate?: boolean } = {},
): Promise<IdentityView | undefined> {
  let q = tx.selectFrom('identities').selectAll().where('id', '=', id).where('workspace_id', '=', workspaceId);
  if (opts.forUpdate) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  return row === undefined ? undefined : toView(row);
}

/** The live identity with this normalised address and its owner's title, or undefined. */
export async function liveByAddress(
  tx: Db, workspaceId: string, channel: Channel, address: string,
): Promise<(IdentityView & { ownerTitle: string }) | undefined> {
  const row = await tx.selectFrom('identities as i').innerJoin('records as r', 'r.id', 'i.owner_id')
    .selectAll('i').select('r.title as owner_title')
    .where('i.workspace_id', '=', workspaceId).where('i.channel', '=', channel)
    .where('i.address_normalized', '=', address).where('i.archived_at', 'is', null)
    .executeTakeFirst();
  return row === undefined ? undefined : { ...toView(row), ownerTitle: row.owner_title };
}

/** The live identities of the owners, oldest first. */
export async function liveOfOwners(tx: Db, workspaceId: string, ownerIds: string[]): Promise<IdentityView[]> {
  if (ownerIds.length === 0) return [];
  const rows = await tx.selectFrom('identities').selectAll()
    .where('workspace_id', '=', workspaceId).where('owner_id', 'in', ownerIds).where('archived_at', 'is', null)
    .orderBy('created_at').orderBy('id').execute();
  return rows.map(toView);
}

/** Like `liveOfOwners`, but locks the rows (in id order). */
export async function lockLiveOfOwners(tx: Db, workspaceId: string, ownerIds: string[]): Promise<IdentityView[]> {
  if (ownerIds.length === 0) return [];
  const rows = await tx.selectFrom('identities').selectAll()
    .where('workspace_id', '=', workspaceId).where('owner_id', 'in', ownerIds).where('archived_at', 'is', null)
    .orderBy('id').forUpdate().execute();
  return rows.map(toView);
}

export async function setIdentityOwner(tx: Db, id: string, ownerId: string): Promise<void> {
  await tx.updateTable('identities').set({ owner_id: ownerId }).where('id', '=', id).execute();
}

export async function patchIdentity(
  tx: Db, id: string, patch: { label?: string | null; verified?: boolean; display?: string },
): Promise<IdentityView> {
  const set: { label?: string | null; verified?: boolean; address_display?: string } = {};
  if (patch.label !== undefined) set.label = patch.label;
  if (patch.verified !== undefined) set.verified = patch.verified;
  if (patch.display !== undefined) set.address_display = patch.display;
  const row = Object.keys(set).length === 0
    ? await tx.selectFrom('identities').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
    : await tx.updateTable('identities').set(set).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  return toView(row);
}

export async function archiveIdentities(tx: Db, ids: string[], at: Date): Promise<void> {
  if (ids.length === 0) return;
  await tx.updateTable('identities').set({ archived_at: at }).where('id', 'in', ids).execute();
}

/** `%`, `_` and `\` of a user's text are matched literally in `ILIKE`. */
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, '\\$&');

/**
 * Live identities whose normalised or displayed address contains `q` (case-insensitive), with their owners'
 * titles, oldest first. `q` without spaces, dashes, dots and brackets is also tried against the normalised
 * address, so a phone is found by digits however it was typed.
 */
export async function searchLive(
  tx: Db, workspaceId: string, q: string, limit: number,
): Promise<(IdentityView & { ownerTitle: string })[]> {
  const like = `%${escapeLike(q)}%`;
  const compact = q.replace(/[\s().-]/g, '');
  const compactLike = `%${escapeLike(compact)}%`;
  const rows = await tx.selectFrom('identities as i').innerJoin('records as r', 'r.id', 'i.owner_id')
    .selectAll('i').select('r.title as owner_title')
    .where('i.workspace_id', '=', workspaceId).where('i.archived_at', 'is', null)
    .where((eb) => eb.or([
      sql<boolean>`i.address_normalized ilike ${like}`,
      sql<boolean>`i.address_display ilike ${like}`,
      ...(compact === '' ? [] : [sql<boolean>`i.address_normalized ilike ${compactLike}`]),
    ]))
    .orderBy('i.created_at').orderBy('i.id').limit(limit).execute();
  return rows.map((r) => ({ ...toView(r), ownerTitle: r.owner_title }));
}

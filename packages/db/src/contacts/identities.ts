import { identityChannel, normalizeAddress, type Channel, type CompiledConfig, type RecordError } from '@icrm/core';
import type { Kysely } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { appendChangeLog } from '../repo/change-log.js';
import {
  archiveIdentities, insertIdentity, liveByAddress, liveOfOwners, loadIdentity, lockLiveOfOwners, patchIdentity,
  searchLive, setIdentityOwner, type IdentityView,
} from '../repo/identities.js';
import { loadRecords, type StoredRecord } from '../repo/records.js';
import type { Db } from '../repo/types.js';
import type { DB } from '../schema.js';
import { recordError, SaveFailed, uniqueViolation, versionConflict } from '../service/errors.js';
import { withRetry } from '../service/retry.js';

export type { IdentityView } from '../repo/identities.js';

/** A new address of `ownerId`. */
export interface AddInput {
  ownerId: string; channel: string; address: string; label?: string | null; verified?: boolean; userId: string;
}

type Parsed = { ok: true; channel: Channel; normalized: string; display: string };

export type IdentityResult = { ok: true; identity: IdentityView } | { ok: false; errors: RecordError[] };

/** The sets whose records may own addresses. */
export const OWNER_SETS = ['contact', 'membership', 'organization'] as const;

const SEARCH_LIMIT = 20;
const LIVE_ADDRESS = 'identities_live_address';

const identityNotFound = (id: string): RecordError => recordError('not_found', `Адрес ${id} не найден`);
const identityArchived = (id: string): RecordError => recordError('archived', `Адрес ${id} в архиве, его нельзя изменить`);
const invalidOwner = (): RecordError =>
  recordError('invalid_owner', 'Владельцем адреса может быть контакт, участие или организация');
const taken = (ownerId: string, ownerTitle: string): RecordError =>
  recordError('identity_taken', `Адрес уже принадлежит «${ownerTitle}»`, { ownerId, ownerTitle });

const canOwn = (r: StoredRecord | undefined): r is StoredRecord =>
  r !== undefined && r.archivedAt === null && OWNER_SETS.some((s) => r.sets.has(s));

/** What the change log keeps of an identity (spec 2a §3.3). */
const logged = (i: IdentityView): { identityId: string; channel: Channel; address: string } =>
  ({ identityId: i.id, channel: i.channel, address: i.address });

/**
 * Channel addresses (spec 2a §3): added to, moved between and archived from records that have the contact,
 * membership or organization set. An address is unique among the live ones of its channel (the phone of
 * WhatsApp is a `phone`). Every change is checked, locked and logged here; owners are locked before the
 * address row, the order record saves use too.
 */
export class IdentityService {
  private readonly db: Kysely<DB>;
  private readonly cfg: CompiledConfig;
  private readonly workspaceId: string;
  private readonly now: () => Date;

  constructor(o: { db: Kysely<DB>; cfg: CompiledConfig; workspaceId: string; now?: () => Date }) {
    this.db = o.db;
    this.cfg = o.cfg;
    this.workspaceId = o.workspaceId;
    this.now = o.now ?? (() => new Date());
  }

  /** Adds an address to `ownerId`. The owner is locked; a taken address names its current owner. */
  async add(i: AddInput): Promise<IdentityResult> {
    const parsed = this.parse(i.channel, i.address);
    if (!parsed.ok) return { ok: false, errors: parsed.errors };
    const res = await this.run((tx) => this.insertRow(tx, parsed, i));
    if (res.ok) return { ok: true, identity: res.value };
    if (!res.conflict) return { ok: false, errors: res.errors };
    // The other add won the race and committed: its owner is the live holder now.
    const holder = await liveByAddress(this.db, this.workspaceId, parsed.channel, parsed.normalized);
    return { ok: false, errors: [holder === undefined ? res.errors[0]! : taken(holder.ownerId, holder.ownerTitle)] };
  }

  /**
   * Inside the caller's transaction: adds an address like `add` (owner locked first, logged); failures
   * (`invalid_address`, `identity_taken`, `invalid_owner`) are thrown as `SaveFailed`. A concurrent add of the
   * same address surfaces as the unique violation, which the caller's save turns into `identity_taken`.
   */
  async addIn(tx: Db, i: AddInput): Promise<IdentityView> {
    const parsed = this.parse(i.channel, i.address);
    if (!parsed.ok) throw new SaveFailed(parsed.errors);
    return this.insertRow(tx, parsed, i);
  }

  /** Changes the label, the verified flag or the displayed spelling (which must still be the same address). */
  async update(i: {
    id: string; label?: string | null; verified?: boolean; display?: string; userId: string;
  }): Promise<IdentityResult> {
    const res = await this.run(async (tx) => {
      const { identity } = await this.lockIdentity(tx, i.id);
      if (identity.archivedAt !== null) throw new SaveFailed([identityArchived(i.id)]);
      if (i.display !== undefined) {
        const n = normalizeAddress(identity.channel, i.display, this.cfg.phoneRegion);
        if (!n.ok) throw new SaveFailed([recordError('invalid_address', n.message)]);
        if (n.normalized !== identity.address) {
          throw new SaveFailed([recordError('invalid_address', 'Отображаемый адрес должен совпадать с адресом')]);
        }
      }
      return patchIdentity(tx, i.id, { label: i.label, verified: i.verified, display: i.display?.trim() });
    });
    return res.ok ? { ok: true, identity: res.value } : { ok: false, errors: res.errors };
  }

  /** Moves a live address to another owner; moving it to its owner changes nothing. */
  async move(i: { id: string; to: string; userId: string }): Promise<IdentityResult> {
    const res = await this.run((tx) => this.moveRow(tx, i.id, i.to, i.userId));
    return res.ok ? { ok: true, identity: res.value } : { ok: false, errors: res.errors };
  }

  /** Archives an address; it stays for the messages that refer to it and no longer blocks its spelling. */
  async archive(i: { id: string; userId: string }): Promise<IdentityResult> {
    const res = await this.run((tx) => this.archiveRow(tx, i.id, i.userId));
    return res.ok ? { ok: true, identity: res.value } : { ok: false, errors: res.errors };
  }

  /** Inside the caller's transaction: archives an address like `archive`; failures are thrown as `SaveFailed`. */
  async archiveIn(tx: Db, identityId: string, userId: string): Promise<void> {
    await this.archiveRow(tx, identityId, userId);
  }

  /** Live addresses whose normalised or displayed form contains `q`, with their owners' titles. */
  async search(q: string, limit = SEARCH_LIMIT): Promise<(IdentityView & { ownerTitle: string })[]> {
    const text = q.trim();
    if (text === '') return [];
    return searchLive(this.db, this.workspaceId, text, Math.min(Math.max(limit, 1), SEARCH_LIMIT));
  }

  /** The live addresses of `ownerIds`, oldest first. */
  liveOf(tx: Db, ownerIds: string[]): Promise<IdentityView[]> {
    return liveOfOwners(tx, this.workspaceId, ownerIds);
  }

  /**
   * Inside the caller's transaction: moves an address like `move` (owners locked first, both logged);
   * failures are thrown as `SaveFailed`, which the caller's save turns into `{ok: false, errors}`.
   */
  async moveIn(tx: Db, identityId: string, toOwnerId: string, userId: string): Promise<void> {
    await this.moveRow(tx, identityId, toOwnerId, userId);
  }

  /**
   * Inside the caller's transaction: archives the live addresses of the owners (their records are locked by
   * the caller) and logs each one at its owner as `source`. Safe to call twice for the same owners.
   */
  async archiveOfOwnersIn(tx: Db, ownerIds: string[], userId: string, source: 'user' | 'cascade'): Promise<void> {
    const live = await lockLiveOfOwners(tx, this.workspaceId, ownerIds);
    if (live.length === 0) return;
    await archiveIdentities(tx, live.map((l) => l.id), this.now());
    await this.log(tx, userId, source, live.map((l) => ({ recordId: l.ownerId, old: logged(l), new: null })));
  }

  /** The channel and normalised address of an input, or `invalid_address`. */
  private parse(channel: string, address: string): Parsed | { ok: false; errors: RecordError[] } {
    const ch = identityChannel(channel);
    if (ch === null) return { ok: false, errors: [recordError('invalid_address', `Неизвестный канал «${channel}»`)] };
    const n = normalizeAddress(ch, address, this.cfg.phoneRegion);
    if (!n.ok) return { ok: false, errors: [recordError('invalid_address', n.message)] };
    return { ok: true, channel: ch, normalized: n.normalized, display: n.display };
  }

  private async insertRow(tx: Db, p: Parsed, i: AddInput): Promise<IdentityView> {
    await this.lockOwners(tx, [i.ownerId]);
    const holder = await liveByAddress(tx, this.workspaceId, p.channel, p.normalized);
    if (holder !== undefined) throw new SaveFailed([taken(holder.ownerId, holder.ownerTitle)]);
    const identity = await insertIdentity(tx, {
      id: uuidv7(), workspaceId: this.workspaceId, ownerId: i.ownerId, channel: p.channel, address: p.normalized,
      display: p.display, label: i.label ?? null, verified: i.verified ?? false,
    });
    await this.log(tx, i.userId, 'user', [{ recordId: i.ownerId, old: null, new: logged(identity) }]);
    return identity;
  }

  private async moveRow(tx: Db, id: string, toOwnerId: string, userId: string): Promise<IdentityView> {
    const { identity, owners } = await this.lockIdentity(tx, id, [toOwnerId]);
    if (identity.archivedAt !== null) throw new SaveFailed([identityArchived(id)]);
    if (!canOwn(owners.get(toOwnerId))) throw new SaveFailed([invalidOwner()]);
    if (identity.ownerId === toOwnerId) return identity;
    await setIdentityOwner(tx, id, toOwnerId);
    await this.log(tx, userId, 'user', [
      { recordId: identity.ownerId, old: logged(identity), new: null },
      { recordId: toOwnerId, old: null, new: logged(identity) },
    ]);
    return { ...identity, ownerId: toOwnerId };
  }

  private async archiveRow(tx: Db, id: string, userId: string): Promise<IdentityView> {
    const { identity } = await this.lockIdentity(tx, id);
    if (identity.archivedAt !== null) throw new SaveFailed([identityArchived(id)]);
    const at = this.now();
    await archiveIdentities(tx, [id], at);
    await this.log(tx, userId, 'user', [{ recordId: identity.ownerId, old: logged(identity), new: null }]);
    return { ...identity, archivedAt: at.toISOString() };
  }

  /** Locks the owners (workspace records, id order) and checks each can own addresses. */
  private async lockOwners(tx: Db, ownerIds: string[]): Promise<Map<string, StoredRecord>> {
    const owners = await loadRecords(tx, ownerIds, { forUpdate: true, workspaceId: this.workspaceId });
    if (!ownerIds.every((id) => canOwn(owners.get(id)))) throw new SaveFailed([invalidOwner()]);
    return owners;
  }

  /**
   * Locks an identity of the workspace: first its owner's record (plus `extraOwners`, id order), then the
   * row, as a record save does. The identity must not have changed hands meanwhile (`version_conflict`).
   * The owners are returned as loaded, not checked: an archived identity may belong to an archived record.
   */
  private async lockIdentity(
    tx: Db, id: string, extraOwners: string[] = [],
  ): Promise<{ identity: IdentityView; owners: Map<string, StoredRecord> }> {
    const peek = await loadIdentity(tx, this.workspaceId, id);
    if (peek === undefined) throw new SaveFailed([identityNotFound(id)]);
    const owners = await loadRecords(tx, [peek.ownerId, ...extraOwners], { forUpdate: true, workspaceId: this.workspaceId });
    const identity = await loadIdentity(tx, this.workspaceId, id, { forUpdate: true });
    if (identity === undefined) throw new SaveFailed([identityNotFound(id)]);
    if (identity.ownerId !== peek.ownerId) throw new SaveFailed([versionConflict(id)]);
    return { identity, owners };
  }

  private async log(
    tx: Db, userId: string, source: 'user' | 'cascade',
    entries: { recordId: string; old: unknown; new: unknown }[],
  ): Promise<void> {
    await appendChangeLog(tx, entries.map((e) => ({
      workspaceId: this.workspaceId, recordId: e.recordId, userId, kind: 'identity' as const, fieldKey: null,
      old: e.old, new: e.new, source,
    })));
  }

  /**
   * One transaction (re-run after a deadlock). A `SaveFailed` and a unique violation of a known constraint
   * come back as errors; `conflict` marks the violation of the live-address index.
   */
  private async run<T>(work: (tx: Db) => Promise<T>): Promise<
    { ok: true; value: T } | { ok: false; errors: RecordError[]; conflict: boolean }
  > {
    try {
      return { ok: true, value: await withRetry(() => this.db.transaction().execute(work)) };
    } catch (e) {
      if (e instanceof SaveFailed) return { ok: false, errors: e.errors, conflict: false };
      const unique = uniqueViolation(e);
      if (unique === null) throw e;
      const constraint = typeof e === 'object' && e !== null && 'constraint' in e ? e.constraint : undefined;
      return { ok: false, errors: [unique], conflict: constraint === LIVE_ADDRESS };
    }
  }
}

import { emailDomainOf, identityChannel, normalizeAddress, todayIn, type CompiledConfig, type RecordError } from '@icrm/core';
import type { Kysely } from 'kysely';
import { liveByAddress } from '../repo/identities.js';
import { linksFrom } from '../repo/links.js';
import { organizationsByEmailDomain } from '../repo/organizations.js';
import { loadRecords } from '../repo/records.js';
import type { DB } from '../schema.js';
import { recordError } from '../service/errors.js';
import type { RecordService, SaveResult } from '../service/record-service.js';
import {
  endMembership, handoverOf, take, unassignedOf, type EndMembershipInput, type Handover, type HandoverResult,
} from './handover.js';
import type { IdentityService, IdentityView } from './identities.js';
import { isActiveOn, membershipsOf } from './memberships.js';
import { merge, mergePreview, type MergeChoice, type MergeDeps, type MergePreview, type MergeStep } from './merge.js';
import { applyRegistryEntry, type RegistryEntry } from './registry.js';

export interface RecordRef { id: string; title: string }

export type ResolveResult =
  | { ok: false; errors: RecordError[] }
  | {
    ok: true; identity: IdentityView | null; contact: RecordRef | null; membership: RecordRef | null;
    organization: RecordRef | null; membershipEnded: boolean; hints: RecordRef[];
  };

/**
 * Operations on contacts and organizations that span several records (spec 2a §4–§6): matching a channel
 * address to a contact and its counterparty, ending a membership with the handover of what hangs on it
 * (the logic lives in `handover.ts`), merging duplicates (`merge.ts`).
 */
export class ContactService {
  private readonly db: Kysely<DB>;
  private readonly cfg: CompiledConfig;
  private readonly workspaceId: string;
  private readonly now: () => Date;
  readonly records: RecordService;
  readonly identities: IdentityService;
  private readonly mergeSteps: readonly MergeStep[];

  /** `mergeSteps` run inside every merge, in order (spec 2a §6.2 p.8); none in 2a. */
  constructor(o: {
    db: Kysely<DB>; cfg: CompiledConfig; workspaceId: string; now?: () => Date;
    records: RecordService; identities: IdentityService; mergeSteps?: MergeStep[];
  }) {
    this.db = o.db;
    this.cfg = o.cfg;
    this.workspaceId = o.workspaceId;
    this.now = o.now ?? (() => new Date());
    this.records = o.records;
    this.identities = o.identities;
    this.mergeSteps = [...(o.mergeSteps ?? [])];
  }

  /**
   * Finds who owns a channel address (spec 2a §4). An unreadable address is `invalid_address` without a
   * search; an unknown one has no owner, and an email gets `hints`: the live organizations that list its
   * domain in `email_domains`. An address whose owner is archived, or is neither a membership, a contact nor
   * an organization, is unknown in the same way.
   */
  async resolveAddress(channel: string, address: string): Promise<ResolveResult> {
    const ch = identityChannel(channel);
    if (ch === null) return { ok: false, errors: [recordError('invalid_address', `Неизвестный канал «${channel}»`)] };
    const n = normalizeAddress(ch, address, this.cfg.phoneRegion);
    if (!n.ok) return { ok: false, errors: [recordError('invalid_address', n.message)] };

    const found = await liveByAddress(this.db, this.workspaceId, ch, n.normalized);
    const nobody = { contact: null, membership: null, organization: null, membershipEnded: false, hints: [] };
    const unknown = async (): Promise<ResolveResult> => {
      const hints = ch === 'email'
        ? await organizationsByEmailDomain(this.db, this.workspaceId, emailDomainOf(n.normalized)) : [];
      return { ok: true, identity: null, ...nobody, hints };
    };
    if (found === undefined) return unknown();
    const { ownerTitle: _ownerTitle, ...identity } = found;
    const owner = (await loadRecords(this.db, [found.ownerId], { workspaceId: this.workspaceId })).get(found.ownerId);
    // An archived owner no longer answers for its addresses (they are normally archived with it).
    if (owner === undefined || owner.archivedAt !== null) return unknown();
    const base = { ok: true, identity, ...nobody } as const;
    const self = { id: owner.id, title: owner.title };

    if (owner.sets.has('membership')) {
      const today = todayIn(this.now(), this.cfg.timezone);
      return {
        ...base, membership: self, contact: await this.linked(owner.id, 'contact'),
        organization: await this.linked(owner.id, 'organization'),
        membershipEnded: !isActiveOn(owner.data.active_to, today),
      };
    }
    if (owner.sets.has('contact')) return { ...base, contact: self, organization: await this.counterpartyOf(owner.id) };
    if (owner.sets.has('organization')) return { ...base, organization: self };
    return unknown();
  }

  /**
   * The counterparty of a contact by its active memberships: the organization of the only one, or of the
   * single primary one among several; otherwise `null` (the caller asks the user to choose).
   */
  async counterpartyOf(contactId: string): Promise<RecordRef | null> {
    const today = todayIn(this.now(), this.cfg.timezone);
    const ofContact = (await membershipsOf(this.db, this.cfg, this.workspaceId, { contactId }, today)).filter((m) => m.active);
    const orgs = await loadRecords(this.db, ofContact.flatMap((m) => m.organizationId ?? []), { workspaceId: this.workspaceId });
    // Memberships of archived organizations do not count: they are neither the only one nor a rival primary.
    const active = ofContact.filter((m) => m.organizationId !== null && orgs.get(m.organizationId)?.archivedAt === null);
    const pick = active.length === 1 ? active[0] : active.find((m) => m.isPrimary);
    return pick?.organizationId == null ? null : { id: pick.organizationId, title: pick.organizationTitle ?? '' };
  }

  /** What hangs on a membership: its live addresses and the links to it (spec 2a §5.1); null — no such membership. */
  handover(membershipId: string): Promise<Handover | null> {
    return handoverOf(this.deps(), membershipId);
  }

  /** Ends a membership and hands over its addresses and links (spec 2a §5.2), in one transaction. */
  endMembership(i: EndMembershipInput): Promise<HandoverResult> {
    return endMembership(this.deps(), i);
  }

  /**
   * The addresses of an organization and the links to it from fields that also allow a membership: what can
   * be assigned to a person (spec 2a §5.3); null — no such organization.
   */
  unassigned(organizationId: string): Promise<Handover | null> {
    return unassignedOf(this.deps(), organizationId);
  }

  /** Moves the chosen addresses and links of its organization to an active membership (spec 2a §5.3); `successor` is null. */
  take(i: { membershipId: string; identities: string[]; links: string[]; userId: string }): Promise<HandoverResult> {
    return take(this.deps(), i);
  }

  /** What merging `sourceId` into `targetId` would do: conflicts and what moves (spec 2a §6.1). */
  mergePreview(sourceId: string, targetId: string): Promise<{ ok: true; preview: MergePreview } | { ok: false; errors: RecordError[] }> {
    return mergePreview(this.deps(), sourceId, targetId);
  }

  /** Merges duplicate `sourceId` into `targetId` (spec 2a §6.2); the record of the result is `targetId`'s view. */
  merge(i: { sourceId: string; targetId: string; values?: MergeChoice; userId: string }): Promise<SaveResult> {
    return merge(this.deps(), i);
  }

  /**
   * Fills the organization `id` from a registry entry (spec 2b §7.2): title and address when empty, the
   * registry's own fields always, `registry_checked_at` = now; one transaction.
   */
  applyRegistryEntry(i: { id: string; entry: RegistryEntry; userId: string }): Promise<SaveResult> {
    return applyRegistryEntry({ records: this.records, workspaceId: this.workspaceId, now: this.now }, i);
  }

  private deps(): MergeDeps {
    return {
      db: this.db, cfg: this.cfg, workspaceId: this.workspaceId, now: this.now, records: this.records, identities: this.identities,
      mergeSteps: this.mergeSteps,
    };
  }

  /** The first record that `fromId` links to through `field`, unless it is archived. */
  private async linked(fromId: string, field: string): Promise<RecordRef | null> {
    const id = (await linksFrom(this.db, fromId, field))[0];
    if (id === undefined) return null;
    const r = (await loadRecords(this.db, [id], { workspaceId: this.workspaceId })).get(id);
    return r === undefined || r.archivedAt !== null ? null : { id: r.id, title: r.title };
  }
}

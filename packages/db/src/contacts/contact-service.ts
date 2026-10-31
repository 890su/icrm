import { emailDomainOf, identityChannel, normalizeAddress, todayIn, type CompiledConfig, type RecordError } from '@icrm/core';
import type { Kysely } from 'kysely';
import { liveByAddress } from '../repo/identities.js';
import { linksFrom } from '../repo/links.js';
import { organizationsByEmailDomain } from '../repo/organizations.js';
import { loadRecords } from '../repo/records.js';
import type { DB } from '../schema.js';
import { recordError } from '../service/errors.js';
import type { RecordService } from '../service/record-service.js';
import type { IdentityService, IdentityView } from './identities.js';
import { isActiveOn, membershipsOf } from './memberships.js';

export interface RecordRef { id: string; title: string }

export type ResolveResult =
  | { ok: false; errors: RecordError[] }
  | {
    ok: true; identity: IdentityView | null; contact: RecordRef | null; membership: RecordRef | null;
    organization: RecordRef | null; membershipEnded: boolean; hints: RecordRef[];
  };

/**
 * Operations on contacts and organizations that span several records (spec 2a §4–§6). Here: matching a
 * channel address to a contact and its counterparty.
 */
export class ContactService {
  private readonly db: Kysely<DB>;
  private readonly cfg: CompiledConfig;
  private readonly workspaceId: string;
  private readonly now: () => Date;
  readonly records: RecordService;
  readonly identities: IdentityService;

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
   * Finds who owns a channel address (spec 2a §4). An unreadable address is `invalid_address` without a
   * search; an unknown one has no owner, and an email gets `hints`: the live organizations that list its
   * domain in `email_domains`.
   */
  async resolveAddress(channel: string, address: string): Promise<ResolveResult> {
    const ch = identityChannel(channel);
    if (ch === null) return { ok: false, errors: [recordError('invalid_address', `Неизвестный канал «${channel}»`)] };
    const n = normalizeAddress(ch, address, this.cfg.phoneRegion);
    if (!n.ok) return { ok: false, errors: [recordError('invalid_address', n.message)] };

    const found = await liveByAddress(this.db, this.workspaceId, ch, n.normalized);
    const nobody = { contact: null, membership: null, organization: null, membershipEnded: false, hints: [] };
    if (found === undefined) {
      const hints = ch === 'email'
        ? await organizationsByEmailDomain(this.db, this.workspaceId, emailDomainOf(n.normalized)) : [];
      return { ok: true, identity: null, ...nobody, hints };
    }
    const { ownerTitle: _ownerTitle, ...identity } = found;
    const owner = (await loadRecords(this.db, [found.ownerId], { workspaceId: this.workspaceId })).get(found.ownerId);
    // An archived owner no longer answers for its addresses (they are normally archived with it).
    if (owner === undefined || owner.archivedAt !== null) return { ok: true, identity: null, ...nobody };
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
    return { ...base, organization: self };
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

  /** The first record that `fromId` links to through `field`, unless it is archived. */
  private async linked(fromId: string, field: string): Promise<RecordRef | null> {
    const id = (await linksFrom(this.db, fromId, field))[0];
    if (id === undefined) return null;
    const r = (await loadRecords(this.db, [id], { workspaceId: this.workspaceId })).get(id);
    return r === undefined || r.archivedAt !== null ? null : { id: r.id, title: r.title };
  }
}

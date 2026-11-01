import { emailDomainOf, PUBLIC_EMAIL_DOMAINS, type CompiledConfig, type RecordError } from '@icrm/core';
import { sql, type Kysely, type Transaction } from 'kysely';
import { loadRecords, type StoredRecord } from '../repo/records.js';
import {
  SEARCH_KINDS, searchHits, searchKeys, searchRowsOf, upsertSearchRows, type SearchHit,
} from '../repo/search.js';
import type { Db } from '../repo/types.js';
import type { DB } from '../schema.js';
import { notFound, recordError } from '../service/errors.js';
import type { RecordRef } from './contact-service.js';

export type DuplicateKind = 'contact' | 'organization';
export type DuplicateReason = 'same_name' | 'similar_name' | 'shared_organization' | 'shared_email_domain' | 'same_address';

/** A live record that may be the same person or company as the asked one (spec 2b §7.1). */
export interface DuplicateCandidate { id: string; title: string; similarity: number; reasons: DuplicateReason[] }

/** Trigram similarity from which names are "similar" (`pg_trgm.similarity_threshold`). */
const SIMILAR_CONTACT = 0.6;
const SIMILAR_ORGANIZATION = 0.7;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
/** Records re-indexed per transaction. */
const REINDEX_BATCH = 500;

const REASON_ORDER: readonly DuplicateReason[] =
  ['same_name', 'similar_name', 'shared_organization', 'shared_email_domain', 'same_address'];

/** The memberships and organizations of contacts, closed memberships included; archived ones are left out. */
async function membershipsByContact(tx: Db, workspaceId: string, contactIds: string[]):
  Promise<Map<string, { memberships: string[]; organizations: Set<string> }>> {
  const out = new Map<string, { memberships: string[]; organizations: Set<string> }>();
  if (contactIds.length === 0) return out;
  const { rows } = await sql<{ contact_id: string; membership_id: string; organization_id: string | null }>`
    select lc.to_id as contact_id, m.id as membership_id, org.id as organization_id
    from links lc
    join records m on m.id = lc.from_id and m.archived_at is null and m.workspace_id = ${workspaceId}
    left join links lo on lo.from_id = m.id and lo.field_key = 'organization'
    left join records org on org.id = lo.to_id and org.archived_at is null and org.workspace_id = ${workspaceId}
    where lc.field_key = 'contact' and lc.to_id = any(${sql.val(contactIds)}::uuid[])
      and exists (select 1 from record_sets rs where rs.record_id = m.id and rs.set_key = 'membership')`.execute(tx);
  for (const r of rows) {
    const entry = out.get(r.contact_id) ?? { memberships: [], organizations: new Set<string>() };
    entry.memberships.push(r.membership_id);
    if (r.organization_id !== null) entry.organizations.add(r.organization_id);
    out.set(r.contact_id, entry);
  }
  return out;
}

/**
 * Non-public domains of the live email addresses owned by each contact or by its live memberships.
 * Every id of `contactIds` is a key of the result.
 */
async function emailDomainsOfContacts(
  tx: Db, workspaceId: string, contactIds: string[], memberships: Map<string, { memberships: string[] }>,
): Promise<Map<string, Set<string>>> {
  const ownerToContact = new Map<string, string>();
  for (const c of contactIds) {
    ownerToContact.set(c, c);
    for (const m of memberships.get(c)?.memberships ?? []) ownerToContact.set(m, c);
  }
  const out = new Map<string, Set<string>>(contactIds.map((c) => [c, new Set<string>()]));
  const owners = [...ownerToContact.keys()];
  if (owners.length === 0) return out;
  const rows = await tx.selectFrom('identities').select(['owner_id', 'address_normalized'])
    .where('workspace_id', '=', workspaceId).where('channel', '=', 'email').where('archived_at', 'is', null)
    .where('owner_id', 'in', owners).execute();
  for (const r of rows) {
    const domain = emailDomainOf(r.address_normalized);
    if (!PUBLIC_EMAIL_DOMAINS.has(domain)) out.get(ownerToContact.get(r.owner_id)!)!.add(domain);
  }
  return out;
}

const intersects = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => [...a].some((x) => b.has(x));

const domainsOfOrganization = (data: Record<string, unknown>): Set<string> =>
  new Set(Array.isArray(data.email_domains) ? data.email_domains.filter((d): d is string => typeof d === 'string') : []);

/** Two records that may be one, `a.id < b.id` (spec 2b §7.1). */
export interface DuplicatePair { a: RecordRef; b: RecordRef; similarity: number; reasons: DuplicateReason[] }

const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sortCandidates = (list: DuplicateCandidate[]): DuplicateCandidate[] =>
  list.sort((a, b) => b.similarity - a.similarity || cmp(a.id, b.id));

const candidate = (hit: SearchHit, reasons: Set<DuplicateReason>): DuplicateCandidate => ({
  id: hit.id, title: hit.title, similarity: hit.similarity,
  reasons: REASON_ORDER.filter((r) => reasons.has(r)),
});

/**
 * Duplicate candidates of contacts and organizations (spec 2b §7.1) over the name index `record_search`,
 * which the `afterWrite` of the `contact`/`organization` sets keeps current. Index rows may be stale (a lost
 * set, an archived record): every query checks the record itself, so they are harmless.
 */
export class DuplicateService {
  private readonly db: Kysely<DB>;
  private readonly cfg: CompiledConfig;
  private readonly workspaceId: string;

  constructor(o: { db: Kysely<DB>; cfg: CompiledConfig; workspaceId: string }) {
    this.db = o.db;
    this.cfg = o.cfg;
    this.workspaceId = o.workspaceId;
  }

  /** Candidates for a live contact/organization, by similarity desc then id; [] for other records. */
  async duplicatesOf(recordId: string): Promise<DuplicateCandidate[]> {
    const rec = (await loadRecords(this.db, [recordId], { workspaceId: this.workspaceId })).get(recordId);
    if (rec === undefined || rec.archivedAt !== null) return [];
    const merged = new Map<string, DuplicateCandidate>();
    for (const kind of SEARCH_KINDS) {
      if (!rec.sets.has(kind) || !this.cfg.sets.has(kind)) continue;
      // One transaction: the similarity threshold is local to it.
      const found = await this.db.transaction().execute((tx) => this.candidatesOfKind(tx, kind, rec));
      for (const c of found) {
        const prev = merged.get(c.id);
        merged.set(c.id, prev === undefined ? c : {
          ...c,
          similarity: Math.max(prev.similarity, c.similarity),
          reasons: REASON_ORDER.filter((r) => prev.reasons.includes(r) || c.reasons.includes(r)),
        });
      }
    }
    return sortCandidates([...merged.values()]);
  }

  /**
   * The candidate pairs among all live records of `kind`, each pair once with `a.id < b.id`, by similarity
   * desc then `a.id`, `b.id`. The rules are those of `duplicatesOf`, run for every record (in batches, one
   * transaction each); a pair is taken from whichever side finds it. Dismissed pairs are never listed.
   *
   * Cost: one candidate search per live record of the kind on every call, and every page repeats it (the
   * sort and `limit`/`offset` are applied in memory). Accepted for the internal scale; a workspace with many
   * thousands of contacts needs a set-based query or a cached pair list.
   */
  async pairs(kind: DuplicateKind, page: { limit?: number; offset?: number } = {}): Promise<DuplicatePair[]> {
    if (!this.cfg.sets.has(kind)) return [];
    const limit = Math.min(Math.max(Math.trunc(page.limit ?? DEFAULT_PAGE), 0), MAX_PAGE);
    const offset = Math.max(Math.trunc(page.offset ?? 0), 0);
    const found = new Map<string, DuplicatePair>();
    let after = NIL_UUID;
    for (;;) {
      const ids = (await this.db.selectFrom('records').select('id')
        .where('workspace_id', '=', this.workspaceId).where('archived_at', 'is', null).where('id', '>', after)
        .where('id', 'in', this.db.selectFrom('record_sets').select('record_id').where('set_key', '=', kind))
        .orderBy('id').limit(REINDEX_BATCH).execute()).map((r) => r.id);
      if (ids.length === 0) break;
      after = ids[ids.length - 1]!;
      await this.db.transaction().execute(async (tx) => {
        const records = await loadRecords(tx, ids, { workspaceId: this.workspaceId });
        for (const rec of records.values()) {
          for (const c of await this.candidatesOfKind(tx, kind, rec)) {
            const [a, b] = rec.id < c.id ? [{ id: rec.id, title: rec.title }, { id: c.id, title: c.title }]
              : [{ id: c.id, title: c.title }, { id: rec.id, title: rec.title }];
            const key = `${a.id}:${b.id}`;
            if (!found.has(key)) found.set(key, { a, b, similarity: c.similarity, reasons: c.reasons });
          }
        }
      });
    }
    return [...found.values()]
      .sort((x, y) => y.similarity - x.similarity || cmp(x.a.id, y.a.id) || cmp(x.b.id, y.b.id))
      .slice(offset, offset + limit);
  }

  /**
   * "Not duplicates": the pair is never offered again. Both records must be live, different and of one kind
   * (`not_found`, `merge_self`, `merge_kind_mismatch`); repeating is a no-op.
   */
  async dismiss(i: { a: string; b: string; userId: string }):
    Promise<{ ok: true } | { ok: false; errors: RecordError[] }> {
    if (i.a === i.b) return { ok: false, errors: [recordError('merge_self', 'Запись нельзя сравнивать саму с собой')] };
    const records = await loadRecords(this.db, [i.a, i.b], { workspaceId: this.workspaceId });
    const missing = [i.a, i.b].filter((id) => {
      const r = records.get(id);
      return r === undefined || r.archivedAt !== null;
    });
    if (missing.length > 0) return { ok: false, errors: missing.map(notFound) };
    const a = records.get(i.a)!;
    const b = records.get(i.b)!;
    if (!SEARCH_KINDS.some((k) => a.sets.has(k) && b.sets.has(k))) {
      return { ok: false, errors: [recordError('merge_kind_mismatch',
        'Пару можно отклонить только для контакта с контактом или организации с организацией')] };
    }
    const [lo, hi] = i.a < i.b ? [i.a, i.b] : [i.b, i.a];
    await this.db.insertInto('duplicate_dismissals')
      .values({ workspace_id: this.workspaceId, a_id: lo, b_id: hi, created_by: i.userId })
      .onConflict((oc) => oc.columns(['workspace_id', 'a_id', 'b_id']).doNothing()).execute();
    return { ok: true };
  }

  private candidatesOfKind(tx: Transaction<DB>, kind: DuplicateKind, rec: StoredRecord): Promise<DuplicateCandidate[]> {
    return kind === 'contact' ? this.contactCandidates(tx, rec) : this.organizationCandidates(tx, rec);
  }

  /** The same name and, for a similar one, a shared organization or email domain. */
  private async contactCandidates(tx: Transaction<DB>, rec: StoredRecord): Promise<DuplicateCandidate[]> {
    const { nameNorm } = searchKeys('contact', rec);
    if (nameNorm === '') return [];
    const hits = await searchHits(tx, {
      workspaceId: this.workspaceId, kind: 'contact', selfId: rec.id, nameNorm, addressNorm: null,
      threshold: SIMILAR_CONTACT, byAddress: false,
    });
    if (hits.length === 0) return [];
    const ids = [rec.id, ...hits.map((h) => h.id)];
    const memberships = await membershipsByContact(tx, this.workspaceId, ids);
    const domains = await emailDomainsOfContacts(tx, this.workspaceId, ids, memberships);
    const myOrgs = memberships.get(rec.id)?.organizations ?? new Set<string>();
    const myDomains = domains.get(rec.id)!;

    const out: DuplicateCandidate[] = [];
    for (const hit of hits) {
      const reasons = new Set<DuplicateReason>([hit.sameName ? 'same_name' : 'similar_name']);
      const sharedOrg = intersects(myOrgs, memberships.get(hit.id)?.organizations ?? new Set());
      const sharedDomain = intersects(myDomains, domains.get(hit.id)!);
      if (sharedOrg) reasons.add('shared_organization');
      if (sharedDomain) reasons.add('shared_email_domain');
      if (hit.sameName || sharedOrg || sharedDomain) out.push(candidate(hit, reasons));
    }
    return out;
  }

  /** A similar name, a shared `email_domains` entry, or the same address. */
  private async organizationCandidates(tx: Transaction<DB>, rec: StoredRecord): Promise<DuplicateCandidate[]> {
    const { nameNorm, addressNorm } = searchKeys('organization', rec);
    const myDomains = domainsOfOrganization(rec.data);
    const hits = await searchHits(tx, {
      workspaceId: this.workspaceId, kind: 'organization', selfId: rec.id, nameNorm, addressNorm,
      threshold: SIMILAR_ORGANIZATION, byAddress: true, domains: [...myDomains],
    });
    return hits.map((hit) => {
      const reasons = new Set<DuplicateReason>();
      if (hit.sameName) reasons.add('same_name');
      else if (hit.similarName) reasons.add('similar_name');
      if (intersects(myDomains, domainsOfOrganization(hit.data))) reasons.add('shared_email_domain');
      if (hit.sameAddress) reasons.add('same_address');
      return candidate(hit, reasons);
    });
  }

  /** Upserts record_search for every live record with contact/organization; returns how many rows were written. */
  async reindex(): Promise<number> {
    let written = 0;
    let after = NIL_UUID;
    for (;;) {
      const ids = (await this.db.selectFrom('records').select('id')
        .where('workspace_id', '=', this.workspaceId).where('archived_at', 'is', null).where('id', '>', after)
        .where('id', 'in', this.db.selectFrom('record_sets').select('record_id').where('set_key', 'in', [...SEARCH_KINDS]))
        .orderBy('id').limit(REINDEX_BATCH).execute()).map((r) => r.id);
      if (ids.length === 0) return written;
      after = ids[ids.length - 1]!;
      written += await this.db.transaction().execute(async (tx) => {
        const records = await loadRecords(tx, ids, { workspaceId: this.workspaceId });
        return upsertSearchRows(tx, [...records.values()].flatMap((r) => searchRowsOf(this.workspaceId, r)));
      });
    }
  }
}

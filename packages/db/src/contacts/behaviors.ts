import {
  normalizeEmailDomain, normalizeNip, PUBLIC_EMAIL_DOMAINS, todayIn,
  type CompiledConfig, type RecordError, type Value,
} from '@icrm/core';
import { sql } from 'kysely';
import { upsertSearch } from '../repo/search.js';
import type { Db } from '../repo/types.js';
import type { SetBehavior } from '../service/behaviors.js';
import { recordError } from '../service/errors.js';
import { OWNER_SETS, type IdentityService } from './identities.js';
import { membershipErrors, membershipsOf, membershipTitle } from './memberships.js';

/**
 * Normalises and checks the `nip` and `email_domains` of a record that is (becoming) an organization, in
 * `input` in place (spec 2a §2.3). The NIP gets its 10 digits and must be unique among live records of the
 * workspace other than `selfId`; a blank one is cleared. Domains are lower case without "@", public mail
 * domains are refused; repeats are dropped, input order is kept.
 */
async function organizationErrors(
  tx: Db, workspaceId: string, input: Record<string, Value>, selfId: string | null,
): Promise<RecordError[]> {
  const errors: RecordError[] = [];
  const nip = input.nip;
  if (typeof nip === 'string') {
    if (nip.trim() === '') {
      input.nip = null;
    } else {
      const normalized = normalizeNip(nip);
      if (normalized === null) {
        errors.push(recordError('nip_invalid', 'Неверный NIP', { field: 'nip' }));
      } else {
        input.nip = normalized;
        // `data ? 'nip'` with `archived_at is null` lets the partial index `records_live_nip` serve the check.
        let q = tx.selectFrom('records').select(['id', 'title'])
          .where('workspace_id', '=', workspaceId).where('archived_at', 'is', null)
          .where(sql<boolean>`data ? 'nip'`).where(sql<string>`data->>'nip'`, '=', normalized);
        if (selfId !== null) q = q.where('id', '<>', selfId);
        const holder = await q.limit(1).executeTakeFirst();
        if (holder !== undefined) {
          errors.push(recordError('nip_taken', `NIP уже у «${holder.title}»`, {
            field: 'nip', ownerId: holder.id, ownerTitle: holder.title }));
        }
      }
    }
  }

  const domains = input.email_domains;
  if (Array.isArray(domains)) {
    const out: string[] = [];
    const before = errors.length;
    for (const raw of domains) {
      const domain = typeof raw === 'string' ? normalizeEmailDomain(raw) : null;
      if (domain === null) {
        errors.push(recordError('invalid_value', `Неверный почтовый домен «${String(raw)}»`, { field: 'email_domains' }));
      } else if (PUBLIC_EMAIL_DOMAINS.has(domain)) {
        errors.push(recordError('public_domain',
          `Домен ${domain} — публичная почта, по нему нельзя узнать организацию`, { field: 'email_domains' }));
      } else if (!out.includes(domain)) {
        out.push(domain);
      }
    }
    if (errors.length === before) input.email_domains = out;
  }
  return errors;
}

/**
 * The behaviours of the system sets. Addresses (spec 2a §3) go with the record that owns them: archiving a
 * record archives its live addresses (logged `cascade`), a view lists the live ones. A record with more than
 * one of the owner sets meets these hooks once per set: the second archive finds nothing live, and the view
 * is filled once. Contacts and organizations also keep their name keys in the duplicate index
 * (`record_search`). On top: an organization has its NIP and domains checked, a membership names itself and
 * keeps its constraints, and the views of contacts and organizations list memberships.
 */
export function contactBehaviors(
  identities: IdentityService, o: { cfg: CompiledConfig; workspaceId: string; now: () => Date },
): SetBehavior[] {
  const today = (): string => todayIn(o.now(), o.cfg.timezone);

  const extras: Record<string, Omit<SetBehavior, 'set' | 'archived'>> = {
    contact: {
      afterWrite: async (ctx, r) => {
        await upsertSearch(ctx.tx, ctx.workspaceId, r.record);
        return [];
      },
      extendView: async (tx, rec, view) => {
        view.memberships = await membershipsOf(tx, o.cfg, o.workspaceId, { contactId: rec.id }, today());
      },
    },
    organization: {
      beforeInsert: (ctx, r) => organizationErrors(ctx.tx, ctx.workspaceId, r.input, null),
      beforeEvaluate: (ctx, r) => organizationErrors(ctx.tx, ctx.workspaceId, r.input, r.id),
      afterWrite: async (ctx, r) => {
        await upsertSearch(ctx.tx, ctx.workspaceId, r.record);
        return [];
      },
      extendView: async (tx, rec, view) => {
        view.memberships = await membershipsOf(tx, o.cfg, o.workspaceId, { organizationId: rec.id }, today());
      },
    },
    membership: {
      beforeEvaluate: async (ctx, r) => {
        if (r.prev !== null || typeof r.input.title !== 'string' || r.input.title.trim() !== '') return [];
        const title = await membershipTitle(ctx.tx, ctx.workspaceId, r.id);
        if (title !== null) r.input.title = title;
        return [];
      },
      afterWrite: (ctx, r) => membershipErrors(ctx.tx, ctx.cfg, ctx.workspaceId, r.record, ctx.now),
    },
  };

  return OWNER_SETS.map((set): SetBehavior => {
    const extra = extras[set] ?? {};
    return {
      ...extra,
      set,
      archived: async (ctx, records) => {
        await identities.archiveOfOwnersIn(ctx.tx, records.map((r) => r.id), ctx.userId, 'cascade');
      },
      extendView: async (tx, rec, view) => {
        if (view.identities === undefined) view.identities = await identities.liveOf(tx, [rec.id]);
        await extra.extendView?.(tx, rec, view);
      },
    };
  });
}

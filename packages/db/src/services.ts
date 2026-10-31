import type { CompiledConfig } from '@icrm/core';
import type { Kysely } from 'kysely';
import { contactBehaviors } from './contacts/behaviors.js';
import { ContactService } from './contacts/contact-service.js';
import { IdentityService } from './contacts/identities.js';
import type { MergeStep } from './contacts/merge.js';
import type { DB } from './schema.js';
import { RecordService } from './service/record-service.js';

/** The services of a workspace, wired together: records save with the behaviours of the system sets. */
export interface Services {
  records: RecordService;
  identities: IdentityService;
  contacts: ContactService;
}

/** `mergeSteps` — the steps of later sub-projects that every merge of duplicates runs (spec 2a §6.2 p.8). */
export function createServices(o: {
  db: Kysely<DB>; cfg: CompiledConfig; workspaceId: string; now?: () => Date; mergeSteps?: MergeStep[];
}): Services {
  const now = o.now ?? ((): Date => new Date());
  const identities = new IdentityService(o);
  const behaviors = contactBehaviors(identities, { cfg: o.cfg, workspaceId: o.workspaceId, now });
  const records = new RecordService({ ...o, behaviors });
  const contacts = new ContactService({ ...o, records, identities });
  return { records, identities, contacts };
}

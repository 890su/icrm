import type { CompiledConfig } from '@icrm/core';
import type { Kysely } from 'kysely';
import { contactBehaviors } from './contacts/behaviors.js';
import { IdentityService } from './contacts/identities.js';
import type { DB } from './schema.js';
import { RecordService } from './service/record-service.js';

/** The services of a workspace, wired together: records save with the behaviours of the system sets. */
export interface Services {
  records: RecordService;
  identities: IdentityService;
}

export function createServices(o: {
  db: Kysely<DB>; cfg: CompiledConfig; workspaceId: string; now?: () => Date;
}): Services {
  const identities = new IdentityService(o);
  const records = new RecordService({ ...o, behaviors: contactBehaviors(identities) });
  return { records, identities };
}

import type { SetBehavior } from '../service/behaviors.js';
import { OWNER_SETS, type IdentityService } from './identities.js';

/**
 * The behaviours of the system sets: the addresses of a record that can own them go with it. Archiving a
 * record archives its live addresses (logged `cascade`); a view lists the live ones. A record with more
 * than one of the three sets meets these hooks once per set: the second archive finds nothing live, and the
 * view is filled once.
 */
export function contactBehaviors(identities: IdentityService): SetBehavior[] {
  return OWNER_SETS.map((set): SetBehavior => ({
    set,
    archived: async (ctx, records) => {
      await identities.archiveOfOwnersIn(ctx.tx, records.map((r) => r.id), ctx.userId, 'cascade');
    },
    extendView: async (tx, rec, view) => {
      if (view.identities === undefined) view.identities = await identities.liveOf(tx, [rec.id]);
    },
  }));
}

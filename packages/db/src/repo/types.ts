import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../schema.js';

/** Every repo function runs on either the root Kysely or an open transaction. */
export type Db = Kysely<DB> | Transaction<DB>;

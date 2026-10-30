import {
  ExprSyntaxError, ExprTypeError, KEY_RE, parse, todayIn, typecheck,
  type CompiledConfig, type Expr, type ExprType, type Pos, type TypeEnv, type Value,
} from '@icrm/core';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import type { DB } from './schema.js';
import type { RecordView } from './service/record-service.js';

export interface QueryInput {
  /** Expression in the shared language; must be bool. Compiled to SQL, evaluated in the database. */
  filter?: string;
  sort?: { field: string; dir: 'asc' | 'desc' }[];
  /** Default 50, maximum 500. */
  limit?: number;
  offset?: number;
  includeArchived?: boolean;
}

export interface QueryOutput {
  items: Pick<RecordView, 'id' | 'title' | 'data' | 'sets' | 'version'>[];
  /** Records matching the filter, ignoring limit and offset. */
  total: number;
}

export type QueryErrorCode = 'syntax' | 'type' | 'unsupported_in_filter';

export class QueryError extends Error {
  readonly code: QueryErrorCode;
  readonly pos?: Pos;

  constructor(code: QueryErrorCode, message: string, pos?: Pos) {
    super(message);
    this.name = 'QueryError';
    this.code = code;
    if (pos !== undefined) this.pos = { start: pos.start, end: pos.end };
  }
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

type Sql = RawBuilder<unknown>;

/**
 * A compiled sub-expression: `sql` is the SQL counterpart of what `evaluate` returns (NULL for an
 * empty value). Money carries its amount in `sql` and its currency in `currency`.
 */
interface Val {
  type: ExprType;
  sql: Sql;
  currency?: Sql;
}

// JS `String.prototype.trim` whitespace: tab, LF, VT, FF, CR, space, NBSP, Zs, LS, PS, BOM.
// (`btrim` would only strip plain spaces.)
const BLANK_RE = '^[\\t\\n\\u000b\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]*$';

const CMP = {
  '=': sql.raw('='), '<>': sql.raw('<>'), '<': sql.raw('<'), '<=': sql.raw('<='), '>': sql.raw('>'), '>=': sql.raw('>='),
} as const;
type CmpOp = keyof typeof CMP;

function isCmpOp(op: string): op is CmpOp {
  return Object.hasOwn(CMP, op);
}

/** Rejects a construct the filter compiler cannot express in SQL. */
const unsupported = (what: string, pos: Pos): never => {
  throw new QueryError('unsupported_in_filter', `${what} не поддерживается в фильтре`, pos);
};

/** Constant-folds a (possibly negated) number literal, so `{hours} > -1` works. */
function constNumber(e: Expr): number | undefined {
  if (e.k === 'num') return e.v;
  if (e.k === 'neg') {
    const v = constNumber(e.e);
    return v === undefined ? undefined : -v;
  }
  return undefined;
}

class FilterCompiler {
  constructor(
    private readonly cfg: CompiledConfig,
    private readonly now: Date,
  ) {}

  /** SQL that is TRUE exactly when `evaluate(e) === true`, never NULL. */
  cond(e: Expr): Sql {
    const v = this.val(e);
    return v.type === 'null' ? sql`false` : sql`coalesce(${v.sql}, false)`;
  }

  // --- fields ------------------------------------------------------------------------------

  /** Raw access to a stored value, typed by the config. The key is always a bound parameter. */
  fieldVal(key: string, type: ExprType): Val {
    if (!KEY_RE.test(key)) throw new QueryError('type', `Недопустимый ключ поля "${key}"`);
    const k = sql`${key}::text`;
    if (typeof type === 'object') return { type, sql: sql`(data->${k})` };
    switch (type) {
      case 'null': return { type, sql: sql`null` };
      case 'number': return { type, sql: sql`((data->>${k})::numeric)` };
      case 'bool': return { type, sql: sql`((data->>${k})::boolean)` };
      case 'money':
        return {
          type,
          sql: sql`(((data->${k})->>'amount')::numeric)`,
          currency: sql`((data->${k})->>'currency')`,
        };
      default: return { type, sql: sql`(data->>${k})` }; // text, date, datetime
    }
  }

  // --- emptiness ---------------------------------------------------------------------------

  /** `isEmpty`: null, "", whitespace-only, [] (never NULL). */
  empty(v: Val): Sql {
    if (v.type === 'null') return sql`true`;
    if (typeof v.type === 'object') {
      return sql`(case jsonb_typeof(${v.sql})
        when 'array' then jsonb_array_length(${v.sql}) = 0
        when 'null' then true
        else ${v.sql} is null end)`;
    }
    switch (v.type) {
      case 'text': case 'date': case 'datetime':
        return sql`coalesce(${v.sql} ~ ${BLANK_RE}::text, true)`;
      default:
        return sql`(${v.sql} is null)`;
    }
  }

  // --- expressions -------------------------------------------------------------------------

  val(e: Expr): Val {
    switch (e.k) {
      case 'num': return { type: 'number', sql: sql`${e.v}::numeric` };
      case 'str': return { type: 'text', sql: sql`${e.v}::text` };
      case 'bool': return { type: 'bool', sql: sql`${e.v}::boolean` };
      case 'null': return { type: 'null', sql: sql`null` };
      case 'field': return this.field(e);
      case 'neg': {
        const n = constNumber(e);
        return n === undefined ? unsupported('Унарный минус', e) : { type: 'number', sql: sql`${n}::numeric` };
      }
      case 'bin': return this.binary(e);
      case 'call': return this.call(e);
    }
  }

  private field(e: Expr & { k: 'field' }): Val {
    const f = this.cfg.fields.get(e.key);
    if (f === undefined || f.valueType === 'link') {
      throw new QueryError('type', `Неизвестное поле {${e.key}}`, e);
    }
    return this.fieldVal(e.key, f.valueType);
  }

  private binary(e: Expr & { k: 'bin' }): Val {
    if (e.op === 'AND' || e.op === 'OR') {
      const word = e.op === 'AND' ? sql` and ` : sql` or `;
      return { type: 'bool', sql: sql`(${this.cond(e.l)}${word}${this.cond(e.r)})` };
    }
    if (isCmpOp(e.op)) return { type: 'bool', sql: this.compare(e.op, this.val(e.l), this.val(e.r)) };
    return unsupported(`Оператор ${e.op}`, e);
  }

  /**
   * Mirrors `compareOp`: an empty side gives FALSE (also for `<>`), a currency mismatch gives NULL,
   * lists compare as ordered sequences. Text and dates compare by code point (collation "C"),
   * datetimes by instant.
   */
  private compare(op: CmpOp, l: Val, r: Val): Sql {
    if (l.type === 'null' || r.type === 'null') return sql`false`;
    const o = CMP[op];
    const t = l.type;
    let inner: Sql;
    if (typeof t === 'object') {
      inner = sql`${l.sql} ${o} ${r.sql}`;
    } else {
      switch (t) {
        case 'text': case 'date':
          inner = sql`(${l.sql} collate "C") ${o} (${r.sql} collate "C")`;
          break;
        case 'datetime':
          inner = sql`${l.sql}::timestamptz ${o} ${r.sql}::timestamptz`;
          break;
        case 'money':
          inner = sql`(case when ${l.currency} <> ${r.currency} then null else ${l.sql} ${o} ${r.sql} end)`;
          break;
        default: // number, bool
          inner = sql`${l.sql} ${o} ${r.sql}`;
      }
    }
    return sql`(case when not ${this.empty(l)} and not ${this.empty(r)} then ${inner} else false end)`;
  }

  private call(e: Expr & { k: 'call' }): Val {
    const bool = (s: Sql): Val => ({ type: 'bool', sql: s });
    switch (e.fn) {
      case 'AND': case 'OR':
        return bool(sql`(${sql.join(e.args.map((a) => this.cond(a)), e.fn === 'AND' ? sql` and ` : sql` or `)})`);
      case 'NOT':
        return bool(sql`(not ${this.cond(e.args[0]!)})`);
      case 'IS_EMPTY':
        return bool(this.empty(this.val(e.args[0]!)));
      case 'HAS_SET': {
        const key = e.args[0];
        if (key?.k !== 'str') throw new QueryError('type', 'HAS_SET принимает только строковый литерал', e);
        return bool(sql`exists (select 1 from record_sets rs where rs.record_id = records.id and rs.set_key = ${key.v}::text)`);
      }
      case 'IN': {
        const [needle, ...candidates] = e.args.map((a) => this.val(a));
        const any = candidates.map((c) => sql`coalesce(${this.compare('=', needle!, c)}, false)`);
        return bool(sql`(${sql.join(any, sql` or `)})`);
      }
      case 'CONTAINS': return bool(this.contains(e));
      case 'DATE': {
        // typecheck has already validated the literal as YYYY-MM-DD
        const lit = e.args[0];
        if (lit?.k !== 'str') throw new QueryError('type', 'DATE принимает только строковый литерал', e);
        return { type: 'date', sql: sql`${lit.v}::text` };
      }
      case 'TODAY': return { type: 'date', sql: sql`${todayIn(this.now, this.cfg.timezone)}::text` };
      case 'NOW': return { type: 'datetime', sql: sql`${this.now.toISOString()}::text` };
      default: return unsupported(`Функция ${e.fn}`, e);
    }
  }

  private contains(e: Expr & { k: 'call' }): Sql {
    const hay = this.val(e.args[0]!);
    const needle = this.val(e.args[1]!);
    if (hay.type === 'null' || needle.type === 'null') return sql`false`;
    const nonEmpty = sql`not ${this.empty(hay)} and not ${this.empty(needle)}`;

    if (typeof hay.type === 'object') {
      // Element equality as jsonb containment. Money and datetime elements have no byte-exact form.
      let element: Sql;
      switch (hay.type.list) {
        case 'text': case 'date': element = sql`to_jsonb(${needle.sql}::text)`; break;
        case 'number': element = sql`to_jsonb(${needle.sql}::numeric)`; break;
        case 'bool': element = sql`to_jsonb(${needle.sql}::boolean)`; break;
        default: return unsupported(`CONTAINS над списком типа ${hay.type.list}`, e);
      }
      return sql`(${nonEmpty} and coalesce(${hay.sql} @> jsonb_build_array(${element}), false))`;
    }
    // strpos + lower rather than ILIKE: no escaping of % and _ in the needle.
    return sql`(${nonEmpty} and strpos(lower(${hay.sql}), lower(${needle.sql})) > 0)`;
  }
}

function parseFilter(src: string): Expr {
  try {
    return parse(src);
  } catch (err) {
    if (err instanceof ExprSyntaxError) throw new QueryError('syntax', err.message, err.pos);
    throw err;
  }
}

function typeEnv(cfg: CompiledConfig, onLink: (key: string) => void): TypeEnv {
  return {
    fieldType(key) {
      const f = cfg.fields.get(key);
      if (f === undefined) return undefined;
      if (f.valueType === 'link') {
        onLink(key);
        return undefined;
      }
      return f.valueType;
    },
    hasSet: (key) => cfg.sets.has(key),
  };
}

/** Parses, type-checks (must be bool) and compiles a filter to a boolean SQL condition. */
function compileFilter(cfg: CompiledConfig, src: string, now: Date): Sql {
  const ast = parseFilter(src);
  let linkHit: string | undefined;
  let type: ExprType;
  try {
    type = typecheck(ast, typeEnv(cfg, (k) => { linkHit = k; }));
  } catch (err) {
    if (!(err instanceof ExprTypeError)) throw err;
    throw new QueryError(
      'type',
      linkHit === undefined ? err.message : `Поле-ссылку нельзя использовать в фильтре: {${linkHit}}`,
      err.pos,
    );
  }
  if (type !== 'bool') {
    throw new QueryError('type', `Фильтр должен быть bool, получен ${typeof type === 'string' ? type : `list<${type.list}>`}`, ast);
  }
  return new FilterCompiler(cfg, now).cond(ast);
}

/** `ORDER BY` term for a scalar field; NULLs go last in both directions. */
function sortTerm(cfg: CompiledConfig, compiler: FilterCompiler, field: string, dir: unknown): Sql {
  if (dir !== 'asc' && dir !== 'desc') throw new QueryError('type', `Направление сортировки: asc или desc, получено ${String(dir)}`);
  const f = cfg.fields.get(field);
  if (f === undefined || f.valueType === 'link') throw new QueryError('type', `Нельзя сортировать по полю "${field}"`);
  const t = f.valueType;
  if (t === 'null' || typeof t === 'object') {
    throw new QueryError('type', `Сортировка по полю "${field}" не поддерживается: тип не скалярный`);
  }
  const direction = dir === 'asc' ? sql`asc` : sql`desc`;
  if (field === 'title') return sql`records.title ${direction} nulls last`;
  const v = compiler.fieldVal(field, t);
  const key = t === 'datetime' ? sql`${v.sql}::timestamptz` : v.sql;
  return sql`${key} ${direction} nulls last`;
}

function pagingValue(name: string, v: number | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  if (!Number.isInteger(v) || v < 0) throw new QueryError('type', `${name} должен быть неотрицательным целым числом`);
  return v;
}

/**
 * Lists records of a workspace matching a filter expression. The filter is compiled to SQL with
 * bound parameters and gives the same result as `evaluate` on each record, including the empty
 * and null semantics; `now` and the config timezone drive TODAY() and NOW().
 */
export async function queryRecords(
  db: Kysely<DB>,
  cfg: CompiledConfig,
  workspaceId: string,
  q: QueryInput,
  now: Date,
): Promise<QueryOutput> {
  const limit = Math.min(pagingValue('limit', q.limit, DEFAULT_LIMIT), MAX_LIMIT);
  const offset = pagingValue('offset', q.offset, 0);
  const filter = q.filter !== undefined && q.filter.trim() !== '' ? compileFilter(cfg, q.filter, now) : undefined;
  const compiler = new FilterCompiler(cfg, now);
  const sorts = (q.sort ?? []).map((s) => sortTerm(cfg, compiler, s.field, s.dir));

  let base = db.selectFrom('records').where('workspace_id', '=', workspaceId);
  if (q.includeArchived !== true) base = base.where('archived_at', 'is', null);
  if (filter !== undefined) base = base.where(sql<boolean>`${filter}`);

  const { n } = await base.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();

  let rowsQuery = base.select(['id', 'title', 'data', 'version']);
  const order = sorts.length > 0 ? [...sorts, sql`records.id`] : [sql`records.created_at desc`, sql`records.id`];
  for (const term of order) rowsQuery = rowsQuery.orderBy(term);
  const rows = await rowsQuery.limit(limit).offset(offset).execute();

  const setsOf = new Map<string, { key: string; enabledBy: string }[]>();
  if (rows.length > 0) {
    const setRows = await db
      .selectFrom('record_sets')
      .select(['record_id', 'set_key', 'enabled_by'])
      .where('record_id', 'in', rows.map((r) => r.id))
      .execute();
    for (const s of setRows.sort((a, b) => (a.set_key < b.set_key ? -1 : a.set_key > b.set_key ? 1 : 0))) {
      const list = setsOf.get(s.record_id) ?? [];
      list.push({ key: s.set_key, enabledBy: s.enabled_by });
      setsOf.set(s.record_id, list);
    }
  }

  return {
    total: Number(n),
    items: rows.map((r) => {
      const { title: _title, ...data } = r.data;
      return { id: r.id, title: r.title, data: data as Record<string, Value>, sets: setsOf.get(r.id) ?? [], version: r.version };
    }),
  };
}

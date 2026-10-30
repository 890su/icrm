import { z } from 'zod';

export type FieldType =
  | 'text' | 'number' | 'money' | 'date' | 'datetime' | 'bool'
  | 'enum' | 'user' | 'file' | 'link' | 'formula' | 'rollup';

export type Agg = 'sum' | 'count' | 'min' | 'max' | 'avg' | 'all' | 'any' | 'list' | 'first';

/** Where a definition came from. `path` is dotted, e.g. `fields.work_cost.expr`. */
export interface SourceRef {
  file: string;
  path: string;
  line?: number;
}

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  multiple?: boolean;
  options?: string[];
  precision?: number;
  multiline?: boolean;
  indexed?: boolean;
  was?: string;
  target_sets?: string[];
  cardinality?: 'one' | 'many';
  inverse_label?: string;
  hierarchical?: boolean;
  expr?: string;
  via?: string;
  direction?: 'forward' | 'inverse';
  field?: string;
  agg?: Agg;
  filter?: string;
  src: SourceRef;
}

export interface SetDef {
  key: string;
  label: string;
  system: boolean;
  fields: string[];
  requires: string[];
  activation: 'manual' | 'rule' | 'both';
  src: SourceRef;
}

export interface RuleDef {
  id: string;
  when: string;
  enable_set?: string;
  show?: string[];
  hide?: string[];
  require?: string[];
  readonly?: string[];
  options?: Record<string, string[]>;
  default?: Record<string, string>;
  validate?: string;
  message?: string;
  src: SourceRef;
}

export interface RawConfig {
  timezone: string;
  fields: FieldDef[];
  sets: SetDef[];
  rules: RuleDef[];
}

export const KEY_RE = /^[a-z][a-z0-9_]*$/;
export const DEFAULT_TIMEZONE = 'Europe/Warsaw';

const str = z.string();
const strList = z.array(z.string());

const common = {
  label: str,
  indexed: z.boolean().optional(),
  was: str.optional(),
};

const field = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), ...common, multiple: z.boolean().optional(), multiline: z.boolean().optional() }),
  z.strictObject({ type: z.literal('number'), ...common, precision: z.number().int().min(0).optional() }),
  z.strictObject({ type: z.literal('money'), ...common }),
  z.strictObject({ type: z.literal('date'), ...common }),
  z.strictObject({ type: z.literal('datetime'), ...common }),
  z.strictObject({ type: z.literal('bool'), ...common }),
  z.strictObject({ type: z.literal('enum'), ...common, options: z.array(z.string()).min(1), multiple: z.boolean().optional() }),
  z.strictObject({ type: z.literal('user'), ...common, multiple: z.boolean().optional() }),
  z.strictObject({ type: z.literal('file'), ...common, multiple: z.boolean().optional() }),
  z.strictObject({
    type: z.literal('link'),
    ...common,
    target_sets: z.array(z.string()).min(1),
    cardinality: z.enum(['one', 'many']).default('many'),
    inverse_label: str.optional(),
    hierarchical: z.boolean().optional(),
  }),
  z.strictObject({ type: z.literal('formula'), ...common, expr: str }),
  z.strictObject({
    type: z.literal('rollup'),
    ...common,
    via: str,
    direction: z.enum(['forward', 'inverse']).default('forward'),
    field: str.optional(),
    agg: z.enum(['sum', 'count', 'min', 'max', 'avg', 'all', 'any', 'list', 'first']),
    filter: str.optional(),
  }).refine((v) => v.agg === 'count' || v.field !== undefined, {
    path: ['field'],
    message: 'field is required unless agg is "count"',
  }),
]);

const set = z.strictObject({
  label: str,
  system: z.boolean().default(false),
  fields: strList,
  requires: strList.default([]),
  activation: z.enum(['manual', 'rule', 'both']).default('manual'),
});

const rule = z.strictObject({
  id: str.min(1),
  when: str,
  enable_set: str.optional(),
  show: strList.optional(),
  hide: strList.optional(),
  require: strList.optional(),
  readonly: strList.optional(),
  options: z.record(z.string(), strList).optional(),
  default: z.record(z.string(), z.string()).optional(),
  validate: str.optional(),
  message: str.optional(),
});

const timezone = z.string().refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'unknown IANA time zone' },
);

/** Shape of one config file. All top-level sections are optional. */
export const fileSchema = z.strictObject({
  workspace: z.strictObject({ timezone: timezone.optional() }).optional(),
  fields: z.record(z.string(), field).optional(),
  sets: z.record(z.string(), set).optional(),
  rules: z.array(rule).optional(),
});

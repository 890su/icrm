import { isMap, isSeq, LineCounter, parseDocument, type Document } from 'yaml';
import { ConfigError, type ConfigIssue } from './errors.js';
import {
  DEFAULT_TIMEZONE, fileSchema, KEY_RE,
  type FieldDef, type RawConfig, type RuleDef, type SetDef,
} from './schema.js';

type Path = (string | number)[];

const fmt = (path: Path): string => path.join('.');

/** Source line of `path`; falls back to the nearest ancestor that exists in the document. */
function lineOf(doc: Document.Parsed, lc: LineCounter, path: Path): number | undefined {
  for (let n = path.length; n > 0; n--) {
    const parent = n === 1 ? doc.contents : doc.getIn(path.slice(0, n - 1), true);
    const last = path[n - 1]!;
    let node: unknown;
    if (isMap(parent)) {
      node = parent.items.find((p) => String((p.key as { value?: unknown } | null)?.value ?? p.key) === String(last))?.key;
    } else if (isSeq(parent) && typeof last === 'number') {
      node = parent.items[last];
    }
    const range = (node as { range?: [number, number, number] } | undefined)?.range;
    if (range) return lc.linePos(range[0]).line;
  }
  return undefined;
}

/**
 * Parses and merges YAML config files into a RawConfig. Shape validation only:
 * zod schemas, key format, reserved `title`, duplicates across files.
 * References between fields, sets and rules are checked by the compiler.
 * @throws ConfigError carrying every issue found.
 */
export function parseConfigFiles(files: { name: string; content: string }[]): RawConfig {
  const issues: ConfigIssue[] = [];
  const fields: FieldDef[] = [];
  const sets: SetDef[] = [];
  const rules: RuleDef[] = [];
  const fieldFile = new Map<string, string>();
  const setFile = new Map<string, string>();
  const ruleFile = new Map<string, string>();
  let timezone: { value: string; file: string } | undefined;

  for (const { name: file, content } of files) {
    const lc = new LineCounter();
    const doc = parseDocument(content, { lineCounter: lc });
    const issue = (path: Path, message: string): void => {
      issues.push({ file, path: fmt(path), line: lineOf(doc, lc, path), message });
    };

    if (doc.errors.length > 0) {
      for (const e of doc.errors) {
        issues.push({ file, path: '', line: e.linePos?.[0].line, message: e.message.split('\n')[0] ?? e.message });
      }
      continue;
    }

    const js: unknown = doc.toJS();
    if (js === null || js === undefined) continue; // empty file
    const result = fileSchema.safeParse(js);
    if (!result.success) {
      for (const zi of result.error.issues) {
        const path = zi.path.map((p) => (typeof p === 'symbol' ? String(p) : p));
        if (zi.code === 'unrecognized_keys') {
          for (const k of zi.keys) issue([...path, k], `Unrecognized key "${k}"`);
        } else {
          issue(path, zi.message);
        }
      }
      continue;
    }
    const data = result.data;

    const tz = data.workspace?.timezone;
    if (tz !== undefined) {
      if (timezone && timezone.value !== tz) {
        issue(['workspace', 'timezone'], `timezone already set to "${timezone.value}" in ${timezone.file}`);
      } else timezone ??= { value: tz, file };
    }

    for (const [key, def] of Object.entries(data.fields ?? {})) {
      const path = ['fields', key];
      if (key === 'title') {
        issue(path, '"title" is a built-in field and cannot be redefined');
        continue;
      }
      if (!KEY_RE.test(key)) {
        issue(path, `field key "${key}" must be snake_case (${KEY_RE.source})`);
        continue;
      }
      const prev = fieldFile.get(key);
      if (prev !== undefined) {
        issue(path, `duplicate field "${key}": already defined in ${prev}`);
        continue;
      }
      fieldFile.set(key, file);
      fields.push({ key, ...def, src: { file, path: fmt(path), line: lineOf(doc, lc, path) } });
    }

    for (const [key, def] of Object.entries(data.sets ?? {})) {
      const path = ['sets', key];
      if (!KEY_RE.test(key)) {
        issue(path, `set key "${key}" must be snake_case (${KEY_RE.source})`);
        continue;
      }
      const prev = setFile.get(key);
      if (prev !== undefined) {
        issue(path, `duplicate set "${key}": already defined in ${prev}`);
        continue;
      }
      setFile.set(key, file);
      sets.push({ key, ...def, src: { file, path: fmt(path), line: lineOf(doc, lc, path) } });
    }

    (data.rules ?? []).forEach((def, i) => {
      const prev = ruleFile.get(def.id);
      if (prev !== undefined) {
        issue(['rules', i, 'id'], `duplicate rule id "${def.id}": already defined in ${prev}`);
        return;
      }
      ruleFile.set(def.id, file);
      const path = ['rules', i];
      rules.push({ ...def, src: { file, path: fmt(path), line: lineOf(doc, lc, path) } });
    });
  }

  if (issues.length > 0) throw new ConfigError(issues);
  return { timezone: timezone?.value ?? DEFAULT_TIMEZONE, fields, sets, rules };
}

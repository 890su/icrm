// Coercion of spreadsheet/CSV cell text to field values for import.
// Pure functions, no I/O: shared by server and browser.
import type { CompiledField } from '../config/compile.js';
import type { Value } from '../expr/types.js';

export type Coerced = { ok: true; value: Value } | { ok: false; message: string };

const NUMBER_RE = /^[+-]?(\d+([.,]\d+)?|[.,]\d+)$/;
const TRUE_WORDS: ReadonlySet<string> = new Set(['tak', 'yes', 'true', '1']);
const FALSE_WORDS: ReadonlySet<string> = new Set(['nie', 'no', 'false', '0']);
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const PL_DATE_RE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;

const bad = (what: string, raw: string): Coerced => ({ ok: false, message: `«${raw}» — ${what}` });

/** "YYYY-MM-DD" for a real calendar date, null otherwise. */
function realDate(y: number, m: number, d: number): string | null {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function coerceDate(text: string): string | null {
  const iso = ISO_DATE_RE.exec(text);
  if (iso) return realDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const pl = PL_DATE_RE.exec(text);
  return pl ? realDate(Number(pl[3]), Number(pl[2]), Number(pl[1])) : null;
}

/** Cell text → value of `field`: text/enum as is (`multiple` splits by "," and ";"), number with "," allowed,
 *  bool tak/nie/yes/no/true/false/1/0, date YYYY-MM-DD or DD.MM.YYYY. Empty cell → null; other types are not import targets. */
export function coerceCell(field: CompiledField, raw: string): Coerced {
  const text = raw.trim();
  if (field.multiple && (field.type === 'text' || field.type === 'enum')) {
    const parts = text.split(/[,;]/).map((p) => p.trim()).filter((p) => p !== '');
    return { ok: true, value: parts.length > 0 ? parts : null };
  }
  if (text === '') return { ok: true, value: null };
  if (field.multiple) return bad('несколько значений поддерживаются только для текста и перечисления', raw);
  switch (field.type) {
    case 'text':
    case 'enum':
      return { ok: true, value: text };
    case 'number':
      return NUMBER_RE.test(text) ? { ok: true, value: Number(text.replace(',', '.')) } : bad('не число', raw);
    case 'bool': {
      const w = text.toLowerCase();
      if (TRUE_WORDS.has(w)) return { ok: true, value: true };
      if (FALSE_WORDS.has(w)) return { ok: true, value: false };
      return bad('не да/нет (tak/nie, yes/no, true/false, 1/0)', raw);
    }
    case 'date': {
      const d = coerceDate(text);
      return d !== null ? { ok: true, value: d } : bad('не дата (ГГГГ-ММ-ДД или ДД.ММ.ГГГГ)', raw);
    }
    default:
      return bad(`поле типа «${field.type}» нельзя заполнить из таблицы`, raw);
  }
}

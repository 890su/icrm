import type { CompiledField } from '../config/compile.js';
import type { ExprType, ScalarType, Value } from '../expr/types.js';
import { validDate } from '../expr/value.js';

/** Why a value does not fit its field: wrong shape (`invalid_value`) or not among `options` (`invalid_option`). */
export interface ValueProblem {
  code: 'invalid_value' | 'invalid_option';
  message: string;
}

const AMOUNT_RE = /^-?\d+(\.\d+)?$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const DATETIME_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?Z$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Check = (v: Value) => boolean;

const isText: Check = (v) => typeof v === 'string';
const isNumber: Check = (v) => typeof v === 'number' && Number.isFinite(v);
const isBool: Check = (v) => typeof v === 'boolean';
const isDate: Check = (v) => validDate(v) !== null;
const isUuid: Check = (v) => typeof v === 'string' && UUID_RE.test(v);

const isMoney: Check = (v) => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  return keys.length === 2 && typeof v.amount === 'string' && AMOUNT_RE.test(v.amount)
    && typeof v.currency === 'string' && CURRENCY_RE.test(v.currency);
};

const isDatetime: Check = (v) => {
  const m = typeof v === 'string' ? DATETIME_RE.exec(v) : null;
  return m !== null && isDate(m[1]!) && Number(m[2]) < 24 && Number(m[3]) < 60 && Number(m[4]) < 60;
};

const SCALAR: Record<ScalarType, { check: Check; what: string }> = {
  text: { check: isText, what: 'строка' },
  number: { check: isNumber, what: 'конечное число' },
  money: { check: isMoney, what: 'сумма {amount: "десятичная строка", currency: "три заглавные буквы"}' },
  date: { check: isDate, what: 'дата YYYY-MM-DD' },
  datetime: { check: isDatetime, what: 'дата-время ISO-8601 UTC с Z' },
  bool: { check: isBool, what: 'TRUE/FALSE' },
};

const UUID = { check: isUuid, what: 'uuid' };

function invalid(f: CompiledField, what: string): ValueProblem {
  return { code: 'invalid_value', message: `Поле «${f.label}»: ожидается ${what}` };
}

/** Checks `v` against a scalar check, or every element when the field holds a list. */
function shape(f: CompiledField, v: Value, many: boolean, s: { check: Check; what: string }): ValueProblem | null {
  if (!many) return s.check(v) ? null : invalid(f, s.what);
  return Array.isArray(v) && v.every(s.check) ? null : invalid(f, `список: ${s.what}`);
}

function ofExprType(f: CompiledField, v: Value, t: ExprType): ValueProblem | null {
  if (t === 'null') return invalid(f, 'пустое значение');
  return typeof t === 'string' ? shape(f, v, false, SCALAR[t]) : shape(f, v, true, SCALAR[t.list]);
}

/**
 * Format of a value and membership in the field's own `options`. `null` is always valid
 * (presence is the job of `require`). Rule-level `options` are not considered here.
 */
export function checkValue(f: CompiledField, v: Value): ValueProblem | null {
  if (v === null) return null;
  const many = f.multiple === true;
  switch (f.type) {
    case 'text':
    case 'number':
    case 'money':
    case 'date':
    case 'datetime':
    case 'bool':
      return shape(f, v, many, SCALAR[f.type]);
    case 'user':
    case 'file':
      return shape(f, v, many, UUID);
    case 'enum': {
      const problem = shape(f, v, many, SCALAR.text);
      if (problem) return problem;
      const outside = (many ? (v as string[]) : [v as string]).filter((x) => !(f.options ?? []).includes(x));
      return outside.length === 0
        ? null
        : { code: 'invalid_option', message: `Поле «${f.label}»: недопустимое значение ${outside.map((x) => `"${x}"`).join(', ')}` };
    }
    case 'link':
      return { code: 'invalid_value', message: `Поле «${f.label}»: значения ссылок хранятся в связях, а не в данных записи` };
    case 'formula':
    case 'rollup':
      return f.valueType === 'link' ? invalid(f, 'пустое значение') : ofExprType(f, v, f.valueType);
  }
}

/** `null` when `v` fits the field (format and the field's own `options`), else a message. */
export function validateValue(f: CompiledField, v: Value): string | null {
  return checkValue(f, v)?.message ?? null;
}

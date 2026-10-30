import { ExprSyntaxError, type Pos } from './ast.js';

export type Token = Pos & (
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'field'; key: string }
  | { t: 'ident'; name: string }
  // '+' '-' '*' '/' '&' '=' '<>' '<' '<=' '>' '>=' '(' ')' and ',' (also for ';')
  | { t: 'op'; v: string }
  | { t: 'eof' }
);

const IDENT_START = /[\p{L}_]/u;
const IDENT_PART = /[\p{L}\p{N}_]/u;
const DIGIT = /[0-9]/;

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;

  while (i < src.length) {
    const c = src[i]!;

    if (/\s/.test(c)) { i++; continue; }

    const start = i;

    if (DIGIT.test(c)) {
      while (i < src.length && DIGIT.test(src[i]!)) i++;
      if (src[i] === ',' && DIGIT.test(src[i + 1] ?? '')) {
        throw new ExprSyntaxError(
          'используйте точку как десятичный разделитель (1.5, а не 1,5)',
          { start: i, end: i + 1 },
        );
      }
      if (src[i] === '.' && DIGIT.test(src[i + 1] ?? '')) {
        i++;
        while (i < src.length && DIGIT.test(src[i]!)) i++;
      }
      out.push({ t: 'num', v: Number(src.slice(start, i)), start, end: i });
      continue;
    }

    if (c === '"') {
      i++;
      let v = '';
      for (;;) {
        if (i >= src.length) {
          throw new ExprSyntaxError('строка не закрыта кавычкой', { start, end: src.length });
        }
        if (src[i] === '"') {
          if (src[i + 1] === '"') { v += '"'; i += 2; continue; } // "" = literal quote
          i++;
          break;
        }
        v += src[i++];
      }
      out.push({ t: 'str', v, start, end: i });
      continue;
    }

    if (c === '{') {
      const close = src.indexOf('}', i + 1);
      if (close < 0) {
        throw new ExprSyntaxError('ссылка на поле не закрыта символом }', { start, end: src.length });
      }
      const key = src.slice(i + 1, close).trim();
      if (key === '') {
        throw new ExprSyntaxError('пустая ссылка на поле', { start, end: close + 1 });
      }
      i = close + 1;
      out.push({ t: 'field', key, start, end: i });
      continue;
    }

    if (IDENT_START.test(c)) {
      while (i < src.length && IDENT_PART.test(src[i]!)) i++;
      out.push({ t: 'ident', name: src.slice(start, i), start, end: i });
      continue;
    }

    const two = src.slice(i, i + 2);
    if (two === '<>' || two === '<=' || two === '>=') {
      i += 2;
      out.push({ t: 'op', v: two, start, end: i });
      continue;
    }

    if ('+-*/&=<>(),;'.includes(c)) {
      i++;
      out.push({ t: 'op', v: c === ';' ? ',' : c, start, end: i });
      continue;
    }

    throw new ExprSyntaxError(`неожиданный символ «${c}»`, { start, end: i + 1 });
  }

  out.push({ t: 'eof', start: src.length, end: src.length });
  return out;
}

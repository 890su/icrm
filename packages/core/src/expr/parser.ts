import { ExprSyntaxError, type BinOp, type Expr } from './ast.js';
import { tokenize, type Token } from './lexer.js';

export { ExprSyntaxError } from './ast.js';

/** Russian aliases -> canonical English names (keys are upper case). */
const ALIASES: Record<string, string> = {
  'ЕСЛИ': 'IF',
  'И': 'AND',
  'ИЛИ': 'OR',
  'НЕ': 'NOT',
  'ПУСТО': 'IS_EMPTY',
  'ЕСТЬ_НАБОР': 'HAS_SET',
  'СЕГОДНЯ': 'TODAY',
  'ДНЕЙ_МЕЖДУ': 'DAYS_BETWEEN',
  'ИСТИНА': 'TRUE',
  'ЛОЖЬ': 'FALSE',
};

function canonical(name: string): string {
  const up = name.toUpperCase();
  return ALIASES[up] ?? up;
}

// Binding powers, weaker -> stronger: OR < AND < comparison < & < + - < * / < unary -
const BP: Record<string, number> = {
  OR: 1,
  AND: 2,
  '=': 3, '<>': 3, '<': 3, '<=': 3, '>': 3, '>=': 3,
  '&': 4,
  '+': 5, '-': 5,
  '*': 6, '/': 6,
};
const UNARY_BP = 7;

function isOp(t: Token, v: string): boolean {
  return t.t === 'op' && t.v === v;
}

function describe(t: Token): string {
  switch (t.t) {
    case 'num': return `число ${t.v}`;
    case 'str': return 'строка';
    case 'field': return `поле {${t.key}}`;
    case 'ident': return `«${t.name}»`;
    case 'op': return `«${t.v}»`;
    case 'eof': return 'конец выражения';
  }
}

class Parser {
  private i = 0;
  constructor(private readonly toks: Token[]) {}

  private peek(): Token { return this.toks[this.i]!; }
  private next(): Token { return this.toks[this.i++]!; }

  parseAll(): Expr {
    const e = this.expr(0);
    const t = this.peek();
    if (t.t !== 'eof') throw this.unexpected(t);
    return e;
  }

  /** Binary operator at the current (infix) position, if any. */
  private infix(): [BinOp, number] | null {
    const t = this.peek();
    if (t.t === 'op' && t.v in BP) return [t.v as BinOp, BP[t.v]!];
    if (t.t === 'ident') {
      const c = canonical(t.name);
      if (c === 'AND' || c === 'OR') return [c, BP[c]!];
    }
    return null;
  }

  private expr(minBp: number): Expr {
    let left = this.prefix();
    for (;;) {
      const inf = this.infix();
      if (!inf || inf[1] <= minBp) return left; // left-associative
      this.next();
      const right = this.expr(inf[1]);
      left = { k: 'bin', op: inf[0], l: left, r: right, start: left.start, end: right.end };
    }
  }

  private prefix(): Expr {
    const t = this.next();
    switch (t.t) {
      case 'num': return { k: 'num', v: t.v, start: t.start, end: t.end };
      case 'str': return { k: 'str', v: t.v, start: t.start, end: t.end };
      case 'field': return { k: 'field', key: t.key, start: t.start, end: t.end };
      case 'ident': return this.identifier(t);
      case 'op':
        if (t.v === '-') {
          const e = this.expr(UNARY_BP - 1);
          return { k: 'neg', e, start: t.start, end: e.end };
        }
        if (t.v === '(') {
          const e = this.expr(0);
          this.expectClose();
          return e;
        }
        throw this.unexpected(t);
      default:
        throw this.unexpected(t);
    }
  }

  private identifier(t: Extract<Token, { t: 'ident' }>): Expr {
    const name = canonical(t.name);
    if (isOp(this.peek(), '(')) {
      this.next();
      const args: Expr[] = [];
      if (!isOp(this.peek(), ')')) {
        do {
          args.push(this.expr(0));
        } while (isOp(this.peek(), ',') && this.next());
      }
      const close = this.expectClose();
      return { k: 'call', fn: name, args, start: t.start, end: close.end };
    }
    if (name === 'TRUE' || name === 'FALSE') {
      return { k: 'bool', v: name === 'TRUE', start: t.start, end: t.end };
    }
    if (name === 'NULL') return { k: 'null', start: t.start, end: t.end };
    throw new ExprSyntaxError(
      `неизвестное слово «${t.name}»; ссылки на поля пишутся в фигурных скобках: {ключ}`,
      { start: t.start, end: t.end },
    );
  }

  private expectClose(): Token {
    const t = this.next();
    if (isOp(t, ')')) return t;
    throw new ExprSyntaxError(
      t.t === 'eof' ? 'ожидалась закрывающая скобка )' : `ожидалась закрывающая скобка ), найдено ${describe(t)}`,
      { start: t.start, end: t.end },
    );
  }

  private unexpected(t: Token): ExprSyntaxError {
    return new ExprSyntaxError(
      t.t === 'eof' ? 'неожиданный конец выражения' : `неожиданный элемент ${describe(t)}`,
      { start: t.start, end: t.end },
    );
  }
}

export function parse(src: string): Expr {
  return new Parser(tokenize(src)).parseAll();
}

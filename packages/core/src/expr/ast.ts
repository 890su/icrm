export type Pos = { start: number; end: number };

export type BinOp =
  | '+' | '-' | '*' | '/' | '&'
  | '=' | '<>' | '<' | '<=' | '>' | '>='
  | 'AND' | 'OR';

export type Expr = Pos & (
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'null' }
  | { k: 'field'; key: string }
  | { k: 'neg'; e: Expr }
  | { k: 'bin'; op: BinOp; l: Expr; r: Expr }
  // fn — canonical English name, upper case
  | { k: 'call'; fn: string; args: Expr[] }
);

export class ExprSyntaxError extends Error {
  readonly pos: Pos;

  constructor(message: string, pos: Pos) {
    super(message);
    this.name = 'ExprSyntaxError';
    this.pos = pos;
  }
}

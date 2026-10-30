export type { BinOp, Expr, Pos } from './expr/ast.js';
export { ExprSyntaxError, parse } from './expr/parser.js';
export type {
  EvalCtx, ExprType, Money, ScalarType, TypeEnv, Value,
} from './expr/types.js';
export { ExprTypeError, typecheck } from './expr/typecheck.js';
export { evaluate, isEmpty, todayIn } from './expr/evaluate.js';
export { fieldRefs, setRefs, usesClock } from './expr/refs.js';
export { FUNCTIONS, type FnSpec } from './expr/functions.js';
export { ConfigError, type ConfigIssue } from './config/errors.js';
export type {
  Agg, FieldDef, FieldType, RawConfig, RuleDef, SetDef, SourceRef,
} from './config/schema.js';
export { parseConfigFiles } from './config/parse.js';
export { KEY_RE } from './config/schema.js';
export { compileConfig } from './config/compile.js';
export type {
  CompiledConfig, CompiledField, CompiledRollup, CompiledRule, CompiledSet,
} from './config/compile.js';
export { validateValue } from './engine/values.js';
export { evaluateRecord, fieldStatesOf } from './engine/evaluate-record.js';
export type {
  ErrorCode, EvalOptions, EvalResult, FieldState, RecordError, RecordState,
} from './engine/evaluate-record.js';
export { computeRollup, type RelatedRecord } from './engine/aggregate.js';
export { rollupsFedBy, rollupsVia } from './engine/cascade-plan.js';

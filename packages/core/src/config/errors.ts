export interface ConfigIssue {
  file: string;
  /** Dotted path inside the file, e.g. `fields.work_cost.expr` or `rules[0].when`. */
  path: string;
  line?: number;
  message: string;
}

export class ConfigError extends Error {
  readonly issues: ConfigIssue[];

  constructor(issues: ConfigIssue[]) {
    super(ConfigError.format(issues));
    this.name = 'ConfigError';
    this.issues = issues;
  }

  private static format(issues: ConfigIssue[]): string {
    const lines = issues.map((i) => {
      const where = i.line === undefined ? i.file : `${i.file}:${i.line}`;
      return `${where} ${i.path}: ${i.message}`;
    });
    return `Invalid config (${issues.length} issue${issues.length === 1 ? '' : 's'}):\n${lines.join('\n')}`;
  }
}

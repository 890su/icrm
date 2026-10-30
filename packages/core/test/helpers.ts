import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compileConfig, ConfigError, parseConfigFiles } from '../src/index.js';

/** Content of `test/fixtures/<name>.yaml`. */
export const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}.yaml`, import.meta.url)), 'utf8');

export const compile = (content: string) =>
  compileConfig(parseConfigFiles([{ name: 't.yaml', content }]));

/** Issues of the ConfigError thrown by compiling `content`. */
export function compileIssues(content: string) {
  try {
    compile(content);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return e.issues;
  }
  throw new Error('expected compile to throw');
}

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compileConfig, type CompiledConfig } from './config/compile.js';
import { parseConfigFiles } from './config/parse.js';
import { withSystem } from './config/system.js';

/** Reads `*.yaml` / `*.yml` from `dir` in alphabetical order and compiles them. The only fs user in core. */
export async function loadConfigDir(dir: string): Promise<CompiledConfig> {
  const names = (await readdir(dir)).filter((n) => /\.ya?ml$/i.test(n)).sort();
  const files = await Promise.all(
    names.map(async (name) => ({ name, content: await readFile(join(dir, name), 'utf8') })),
  );
  return compileConfig(parseConfigFiles(withSystem(files)));
}

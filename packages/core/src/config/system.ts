/** Name under which the built-in (system) part of the config is parsed; no user file may use it. */
export const SYSTEM_FILE = '<system>';

/** Built-in sets and fields (contacts, organizations, ...), parsed together with the user's files. */
export const SYSTEM_CONFIG = '';

/** Puts the built-in config part first; `system` overrides it (tests). */
export function withSystem(
  files: { name: string; content: string }[],
  system?: string,
): { name: string; content: string }[] {
  if (files.some((f) => f.name === SYSTEM_FILE)) {
    throw new Error(`имя файла ${SYSTEM_FILE} зарезервировано для встроенной части конфига`);
  }
  return [{ name: SYSTEM_FILE, content: system ?? SYSTEM_CONFIG }, ...files];
}

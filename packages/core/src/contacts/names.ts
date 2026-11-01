// Normalisation of person names, company names and street addresses for duplicate detection.
// Pure functions, no I/O: shared by server and browser.

/** Lower case, diacritics removed (NFD + ł→l, Ł→l), every non-letter/digit → one space, trimmed. */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/ł/g, 'l')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const words = (s: string): string[] => (s === '' ? [] : s.split(' '));

/** normalizeText, words sorted: "Nowak Anna" = "anna nowák" = "anna nowak". */
export function normalizePersonName(s: string): string {
  return words(normalizeText(s)).sort().join(' ');
}

/** Legal forms of Polish companies, in normalised form. */
export const LEGAL_FORMS: readonly string[] = [
  'sp z o o', 'spolka z ograniczona odpowiedzialnoscia', 'sp k', 'spolka komandytowa', 'sp j', 'spolka jawna',
  's a', 'spolka akcyjna', 's c', 'spolka cywilna', 'jdg', 'p h u', 'phu', 'f h u', 'fhu',
];

// Longest sequences first, so "sp z o o" wins over a shorter prefix.
const LEGAL_FORM_WORDS: readonly (readonly string[])[] = LEGAL_FORMS
  .map((f) => f.split(' '))
  .sort((a, b) => b.length - a.length);

function matchesAt(ws: readonly string[], i: number, form: readonly string[]): boolean {
  return form.every((w, k) => ws[i + k] === w);
}

/** normalizeText, legal forms removed (LEGAL_FORMS, matched as whole word sequences), words sorted. */
export function normalizeCompanyName(s: string): string {
  const ws = words(normalizeText(s));
  const kept: string[] = [];
  for (let i = 0; i < ws.length;) {
    const form = LEGAL_FORM_WORDS.find((f) => matchesAt(ws, i, f));
    if (form) i += form.length;
    else kept.push(ws[i++]!);
  }
  return kept.sort().join(' ');
}

const STREET_PREFIXES: ReadonlySet<string> = new Set([
  'ul', 'ulica', 'al', 'aleja', 'pl', 'plac', 'os', 'osiedle',
]);

/** normalizeText, leading street prefix (ul|ulica|al|aleja|pl|plac|os|osiedle) removed; word order kept. */
export function normalizeStreetAddress(s: string): string {
  const ws = words(normalizeText(s));
  if (ws.length > 1 && STREET_PREFIXES.has(ws[0]!)) ws.shift();
  return ws.join(' ');
}

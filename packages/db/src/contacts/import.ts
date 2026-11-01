/** A parsed spreadsheet-like file: headers plus non-empty rows (`line` is the file's row number, header = 1). */
export interface ImportTable {
  headers: string[];
  rows: { line: number; cells: string[] }[];
}

/** One contact to import, with its optional organization and membership (raw cell values, not yet normalised). */
export interface ImportRow {
  line: number;
  contact: { title: string | null; data: Record<string, string> };
  identities: { channel: string; address: string }[];
  organization: { title: string | null; nip: string | null; data: Record<string, string> } | null;
  membership: { role: string[]; position: string | null } | null;
}

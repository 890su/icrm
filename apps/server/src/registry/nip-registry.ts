import type { RegistryEntry } from '@icrm/db';

/** The registry cannot be asked or its answer cannot be used: HTTP error, network failure, timeout, unreadable body. */
export class RegistryUnavailable extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RegistryUnavailable';
  }
}

/** A source of taxpayer data by NIP; `date` (YYYY-MM-DD) is the day the status is asked for. */
export interface NipRegistry {
  /** `null` — the registry has no such taxpayer. */
  lookup(nip: string, date: string): Promise<RegistryEntry | null>;
}

const VAT_STATUS: Record<string, NonNullable<RegistryEntry['vatStatus']>> = {
  Czynny: 'czynny',
  Zwolniony: 'zwolniony',
  Niezarejestrowany: 'niezarejestrowany',
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const textOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/**
 * The answer of `GET /api/search/nip/{nip}` of the VAT white list as a registry entry: `null` when the
 * subject is `null` (no such taxpayer), `RegistryUnavailable` when the body is not of the expected shape.
 */
export function parseWhiteListResponse(body: unknown): RegistryEntry | null {
  const result = isObject(body) ? body.result : undefined;
  if (!isObject(result) || !('subject' in result)) throw new RegistryUnavailable('Реестр ответил в неожиданном формате');
  const s = result.subject;
  if (s === null) return null;
  if (!isObject(s) || typeof s.name !== 'string' || typeof s.nip !== 'string') {
    throw new RegistryUnavailable('Реестр ответил в неожиданном формате');
  }
  return {
    nip: s.nip,
    name: s.name,
    address: textOrNull(s.workingAddress) ?? textOrNull(s.residenceAddress),
    regon: textOrNull(s.regon),
    krs: textOrNull(s.krs),
    vatStatus: typeof s.statusVat === 'string' ? VAT_STATUS[s.statusVat] ?? null : null,
    bankAccounts: Array.isArray(s.accountNumbers) ? s.accountNumbers.filter((a): a is string => typeof a === 'string') : [],
  };
}

/** The VAT white list of the Polish Ministry of Finance (spec 2b §7.2). */
export class MfWhiteList implements NipRegistry {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(o: { baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number } = {}) {
    this.baseUrl = (o.baseUrl ?? 'https://wl-api.mf.gov.pl').replace(/\/+$/, '');
    this.fetchFn = o.fetch ?? ((...args) => fetch(...args));
    this.timeoutMs = o.timeoutMs ?? 10_000;
  }

  async lookup(nip: string, date: string): Promise<RegistryEntry | null> {
    const url = `${this.baseUrl}/api/search/nip/${encodeURIComponent(nip)}?date=${encodeURIComponent(date)}`;
    let body: unknown;
    try {
      const res = await this.fetchFn(url, { signal: AbortSignal.timeout(this.timeoutMs), headers: { accept: 'application/json' } });
      if (!res.ok) throw new RegistryUnavailable(`Реестр ответил HTTP ${res.status}`);
      body = await res.json();
    } catch (e) {
      if (e instanceof RegistryUnavailable) throw e;
      throw new RegistryUnavailable('Реестр недоступен', { cause: e });
    }
    return parseWhiteListResponse(body);
  }
}

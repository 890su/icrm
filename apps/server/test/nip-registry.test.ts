import { describe, expect, test } from 'vitest';
import { MfWhiteList, parseWhiteListResponse, RegistryUnavailable } from '../src/registry/nip-registry.js';

const SUBJECT = {
  name: 'FIRMA X SP. Z O.O.', nip: '5260250274', statusVat: 'Czynny', regon: '012345678', krs: '0000123456',
  workingAddress: 'DŁUGA 5, 00-001 WARSZAWA', residenceAddress: null, accountNumbers: ['12345678901234567890123456'],
};

describe('parseWhiteListResponse', () => {
  test('parses a found subject', () => {
    expect(parseWhiteListResponse({ result: { subject: SUBJECT } })).toEqual({
      nip: '5260250274', name: 'FIRMA X SP. Z O.O.', address: 'DŁUGA 5, 00-001 WARSZAWA', regon: '012345678', krs: '0000123456',
      vatStatus: 'czynny', bankAccounts: ['12345678901234567890123456'],
    });
  });

  test('subject null → null; unknown status → null vatStatus; address falls back to residence', () => {
    expect(parseWhiteListResponse({ result: { subject: null } })).toBeNull();
    expect(parseWhiteListResponse({ result: { subject: { ...SUBJECT, statusVat: 'Wykreślony' } } })?.vatStatus).toBeNull();
    expect(parseWhiteListResponse({ result: { subject: { ...SUBJECT, statusVat: 'Zwolniony' } } })?.vatStatus).toBe('zwolniony');
    expect(parseWhiteListResponse({ result: { subject: { ...SUBJECT, statusVat: 'Niezarejestrowany' } } })?.vatStatus)
      .toBe('niezarejestrowany');
    const home = parseWhiteListResponse({
      result: { subject: { ...SUBJECT, workingAddress: null, residenceAddress: 'KRÓTKA 1, 30-001 KRAKÓW' } } });
    expect(home?.address).toBe('KRÓTKA 1, 30-001 KRAKÓW');
    const bare = parseWhiteListResponse({
      result: { subject: { name: 'X', nip: '5260250274', statusVat: null, regon: null, krs: null } } });
    expect(bare).toEqual({ nip: '5260250274', name: 'X', address: null, regon: null, krs: null, vatStatus: null, bankAccounts: [] });
  });

  test('a body of another shape is RegistryUnavailable', () => {
    expect(() => parseWhiteListResponse({ nope: 1 })).toThrow(RegistryUnavailable);
    expect(() => parseWhiteListResponse(null)).toThrow(RegistryUnavailable);
    expect(() => parseWhiteListResponse({ result: { subject: { nip: '5260250274' } } })).toThrow(RegistryUnavailable);
  });
});

describe('MfWhiteList', () => {
  const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });

  test('requests the right URL and parses the answer', async () => {
    const urls: string[] = [];
    const fetchStub = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return json(200, { result: { subject: SUBJECT } });
    }) as typeof fetch;
    const entry = await new MfWhiteList({ fetch: fetchStub }).lookup('5260250274', '2026-11-01');
    expect(urls).toEqual(['https://wl-api.mf.gov.pl/api/search/nip/5260250274?date=2026-11-01']);
    expect(entry?.name).toBe('FIRMA X SP. Z O.O.');
    const none = await new MfWhiteList({ fetch: (async () => json(200, { result: { subject: null } })) as typeof fetch })
      .lookup('5260250274', '2026-11-01');
    expect(none).toBeNull();
  });

  test('a base URL override is used', async () => {
    const urls: string[] = [];
    const fetchStub = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return json(200, { result: { subject: null } });
    }) as typeof fetch;
    await new MfWhiteList({ fetch: fetchStub, baseUrl: 'http://stub.local/' }).lookup('5260250274', '2026-11-01');
    expect(urls).toEqual(['http://stub.local/api/search/nip/5260250274?date=2026-11-01']);
  });

  test('500, 429, a failing fetch, a non-JSON body and a timeout are RegistryUnavailable', async () => {
    const lookup = (f: typeof fetch, timeoutMs?: number): Promise<unknown> =>
      new MfWhiteList({ fetch: f, timeoutMs }).lookup('5260250274', '2026-11-01');
    await expect(lookup((async () => json(500, {})) as typeof fetch)).rejects.toBeInstanceOf(RegistryUnavailable);
    await expect(lookup((async () => json(429, {})) as typeof fetch)).rejects.toBeInstanceOf(RegistryUnavailable);
    await expect(lookup((async () => { throw new TypeError('fetch failed'); }) as typeof fetch)).rejects.toBeInstanceOf(RegistryUnavailable);
    await expect(lookup((async () => new Response('not json', { status: 200 })) as typeof fetch)).rejects.toBeInstanceOf(RegistryUnavailable);
    const hang = ((_url: unknown, init?: RequestInit) => new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(init.signal?.reason));
    })) as typeof fetch;
    await expect(lookup(hang, 20)).rejects.toBeInstanceOf(RegistryUnavailable);
  });
});

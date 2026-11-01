import { expect, test } from 'vitest';
import {
  LEGAL_FORMS, normalizeCompanyName, normalizePersonName, normalizeStreetAddress, normalizeText,
} from '../../src/index.js';

test.each([
  ['Nowak Anna', 'anna nowak'], ['anna Nowák', 'anna nowak'], ['  ŁUKASZ  Żółć ', 'lukasz zolc'], ['Jan-Paweł II', 'ii jan pawel'],
])('person %s → %s', (raw, n) => expect(normalizePersonName(raw)).toBe(n));
test.each([
  ['Firma X Sp. z o.o.', 'firma x'], ['FIRMA X SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ', 'firma x'],
  ['P.H.U. Kowalski', 'kowalski'], ['Kowalski s.c.', 'kowalski'], ['Bud-Mar S.A.', 'bud mar'],
])('company %s → %s', (raw, n) => expect(normalizeCompanyName(raw)).toBe(n));
test('a legal form inside a word is kept', () => expect(normalizeCompanyName('Sacom')).toBe('sacom'));
test.each([['ul. Długa 5/2', 'dluga 5 2'], ['Aleja Róż 10', 'roz 10'], ['Długa 5/2', 'dluga 5 2']])('address %s', (raw, n) => expect(normalizeStreetAddress(raw)).toBe(n));
test('normalizeText', () => {
  expect(normalizeText('  Żółć, Ł-ódź!  ')).toBe('zolc l odz');
  expect(normalizeText('')).toBe('');
  expect(normalizeText('---')).toBe('');
});
test('legal forms are in normalised form', () => {
  for (const f of LEGAL_FORMS) expect(normalizeText(f)).toBe(f);
});

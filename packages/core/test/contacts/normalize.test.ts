import { expect, test } from 'vitest';
import {
  emailDomainOf, identityChannel, normalizeAddress, normalizeEmailDomain, normalizeNip,
  PUBLIC_EMAIL_DOMAINS,
} from '../../src/index.js';

test.each([
  ['+48 600 100 200', '+48600100200'], ['600-100-200', '+48600100200'], ['0048600100200', '+48600100200'],
  ['(+48) 600 100 200', '+48600100200'], ['+44 20 7946 0958', '+442079460958'],
])('phone %s → %s', (raw, e164) => expect(normalizeAddress('phone', raw, 'PL')).toEqual({ ok: true, normalized: e164, display: raw.trim() }));
test.each(['12', 'abc', '+48 600', 'abc 600100200', '600100200abc', 'call me +48 600 100 200 please', '600 100 200 ext 5'])('phone %s is invalid', (raw) => expect(normalizeAddress('phone', raw, 'PL').ok).toBe(false));
test('region decides national numbers', () => expect(normalizeAddress('phone', '030 901820', 'DE')).toMatchObject({ ok: true, normalized: '+4930901820' }));
test('email', () => {
  expect(normalizeAddress('email', ' Jan.Kowalski@Firma.PL ', 'PL')).toEqual({ ok: true, normalized: 'jan.kowalski@firma.pl', display: 'Jan.Kowalski@Firma.PL' });
  for (const bad of ['jan@', '@firma.pl', 'a@b@c.pl', 'jan@localhost', '', 'jan@.pl', 'jan@firma.', 'jan@a..pl']) expect(normalizeAddress('email', bad, 'PL').ok).toBe(false);
});
test('telegram', () => {
  expect(normalizeAddress('telegram', '123456789', 'PL')).toMatchObject({ normalized: '123456789' });
  expect(normalizeAddress('telegram', '@Jan_Kowalski', 'PL')).toMatchObject({ normalized: '@jan_kowalski' });
  expect(normalizeAddress('telegram', 'jan_kowalski', 'PL')).toMatchObject({ normalized: '@jan_kowalski' });
  for (const bad of ['@abc', '@1abcdef', 'jan kowalski']) expect(normalizeAddress('telegram', bad, 'PL').ok).toBe(false);
});
test('error messages', () => {
  expect(normalizeAddress('email', 'x', 'PL')).toEqual({ ok: false, message: 'Не похоже на адрес почты' });
  expect(normalizeAddress('phone', 'x', 'PL')).toEqual({ ok: false, message: 'Не похоже на номер телефона' });
  expect(normalizeAddress('telegram', 'x', 'PL')).toEqual({ ok: false, message: 'Не похоже на Telegram id или @username' });
});
test('channels', () => {
  expect(identityChannel('whatsapp')).toBe('phone');
  expect(identityChannel('email')).toBe('email');
  expect(identityChannel('sms')).toBeNull();
});
test('nip', () => {
  expect(normalizeNip('5260250274')).toBe('5260250274');
  expect(normalizeNip('PL 526-025-02-74')).toBe('5260250274');
  expect(normalizeNip('5260250275')).toBeNull();
  expect(normalizeNip('526025027')).toBeNull();
});
test('email domains', () => {
  expect(normalizeEmailDomain(' @Firma.PL ')).toBe('firma.pl');
  expect(normalizeEmailDomain('firma')).toBeNull();
  expect(PUBLIC_EMAIL_DOMAINS.has('gmail.com')).toBe(true);
  expect(emailDomainOf('jan@firma.pl')).toBe('firma.pl');
});

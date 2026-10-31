// Normalisation of contact addresses (email, phone, Telegram), Polish NIP and email domains.
// Pure functions, no I/O: shared by server and browser.
import { type CountryCode, parsePhoneNumberFromString } from 'libphonenumber-js/min';

export type Channel = 'email' | 'phone' | 'telegram';
export type Normalized =
  | { ok: true; normalized: string; display: string }
  | { ok: false; message: string };

/** 'email'|'phone'|'telegram' as is, 'whatsapp' → 'phone', anything else → null. */
export function identityChannel(channel: string): Channel | null {
  if (channel === 'email' || channel === 'phone' || channel === 'telegram') return channel;
  if (channel === 'whatsapp') return 'phone';
  return null;
}

const ERR_EMAIL = 'Не похоже на адрес почты';
const ERR_PHONE = 'Не похоже на номер телефона';
const ERR_TELEGRAM = 'Не похоже на Telegram id или @username';

const TELEGRAM_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;

function normalizeEmail(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  const parts = value.split('@');
  if (parts.length !== 2) return null;
  const [local, domain] = parts as [string, string];
  if (!local || !domain || /\s/.test(value)) return null;
  if (!domain.includes('.')) return null;
  // Every dot-separated label must be non-empty (rejects ".pl", "firma.", "a..pl").
  if (domain.split('.').some((label) => label === '')) return null;
  return value;
}

// Only digits and common separators: the library would otherwise pull a number out of free text.
const PHONE_CHARS_RE = /^[0-9\s()+\-./]+$/;

function normalizePhone(raw: string, region: string): string | null {
  if (!PHONE_CHARS_RE.test(raw)) return null;
  const parsed = parsePhoneNumberFromString(raw.trim(), region as CountryCode);
  return parsed?.isValid() ? parsed.number : null;
}

function normalizeTelegram(raw: string): string | null {
  const value = raw.trim();
  if (/^\d+$/.test(value)) return value;
  const name = value.startsWith('@') ? value.slice(1) : value;
  return TELEGRAM_NAME_RE.test(name) ? `@${name.toLowerCase()}` : null;
}

export function normalizeAddress(channel: Channel, raw: string, region: string): Normalized {
  const display = raw.trim();
  const normalized = channel === 'email' ? normalizeEmail(raw)
    : channel === 'phone' ? normalizePhone(raw, region)
      : normalizeTelegram(raw);
  if (normalized !== null) return { ok: true, normalized, display };
  const message = channel === 'email' ? ERR_EMAIL : channel === 'phone' ? ERR_PHONE : ERR_TELEGRAM;
  return { ok: false, message };
}

export function emailDomainOf(normalizedEmail: string): string {
  return normalizedEmail.slice(normalizedEmail.lastIndexOf('@') + 1);
}

const NIP_WEIGHTS = [6, 5, 7, 2, 3, 4, 5, 6, 7];

/** 10 digits with a valid checksum, from input with spaces, dashes and an optional "PL" prefix; null otherwise. */
export function normalizeNip(raw: string): string | null {
  const digits = raw.trim().replace(/^PL/i, '').replace(/[\s-]/g, '');
  if (!/^\d{10}$/.test(digits)) return null;
  const sum = NIP_WEIGHTS.reduce((acc, w, i) => acc + w * Number(digits[i]), 0);
  const check = sum % 11;
  return check !== 10 && check === Number(digits[9]) ? digits : null;
}

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Lower case, no leading "@", a valid domain name; null otherwise. */
export function normalizeEmailDomain(raw: string): string | null {
  const value = raw.trim().replace(/^@/, '').toLowerCase();
  return DOMAIN_RE.test(value) ? value : null;
}

export const PUBLIC_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'wp.pl', 'o2.pl', 'onet.pl', 'op.pl', 'interia.pl', 'poczta.fm',
  'tlen.pl', 'gazeta.pl', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com',
  'me.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.de',
]);

/** Name under which the built-in (system) part of the config is parsed; no user file may use it. */
export const SYSTEM_FILE = '<system>';

/** Built-in sets and fields (contacts, organizations, ...), parsed together with the user's files. */
export const SYSTEM_CONFIG = `fields:
  notes: {type: text, label: Заметки, multiline: true}
  needs_review: {type: bool, label: Проверить}
  merged_into: {type: link, label: Слита в, target_sets: [contact, organization], cardinality: one, managed: true, inverse_label: Слитые записи}
  org_kind: {type: enum, label: Тип, options: [фирма, частный клиент]}
  nip: {type: text, label: NIP}
  address: {type: text, label: Адрес, multiline: true}
  email_domains: {type: text, label: Почтовые домены, multiple: true}
  regon: {type: text, label: REGON}
  krs: {type: text, label: KRS}
  vat_status: {type: enum, label: Статус VAT, options: [czynny, zwolniony, niezarejestrowany]}
  bank_accounts: {type: text, label: Банковские счета, multiple: true}
  registry_checked_at: {type: datetime, label: Проверено в реестре, managed: true}
  contact: {type: link, label: Контакт, target_sets: [contact], cardinality: one, inverse_label: Участия}
  organization: {type: link, label: Организация, target_sets: [organization], cardinality: one, inverse_label: Участники}
  role: {type: enum, label: Роль, options: [ЛПР, бухгалтер, техник, другое], multiple: true}
  position: {type: text, label: Должность}
  active_from: {type: date, label: Действует с}
  active_to: {type: date, label: Действует по}
  is_primary: {type: bool, label: Основное}
  is_active: {type: formula, label: Действует, expr: 'IS_EMPTY({active_to}) OR {active_to} >= TODAY()'}
sets:
  contact: {label: Контакт, fields: [notes, needs_review, merged_into]}
  organization: {label: Организация, fields: [org_kind, nip, address, email_domains, merged_into, regon, krs, vat_status, bank_accounts, registry_checked_at]}
  membership: {label: Участие, fields: [contact, organization, role, position, active_from, active_to, is_primary, is_active]}
rules:
  - id: membership_links_required
    when: 'HAS_SET("membership")'
    require: [contact, organization]
  - id: membership_dates_order
    when: 'HAS_SET("membership") AND NOT(IS_EMPTY({active_from})) AND NOT(IS_EMPTY({active_to}))'
    validate: '{active_to} >= {active_from}'
    message: Дата окончания раньше даты начала
`;

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
